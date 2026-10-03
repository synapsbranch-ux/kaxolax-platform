import { randomUUID } from 'node:crypto'
import { setTimeout as sleep } from 'node:timers/promises'
import app from '@adonisjs/core/services/app'
import { test } from '@japa/runner'
import type { ApiClient } from '@japa/api-client'
import db from '@adonisjs/lucid/services/db'
import type { TransactionClientContract } from '@adonisjs/lucid/types/database'
import { DateTime } from 'luxon'
import ClerkOrganization from '#models/clerk_organization'
import ClerkOrganizationMembership from '#models/clerk_organization_membership'
import File from '#models/file'
import Project from '#models/project'
import ProjectMember from '#models/project_member'
import Subscription from '#models/subscription'
import User from '#models/user'
import Workspace from '#models/workspace'
import WorkspaceMember from '#models/workspace_member'
import {
  creditAccountFor,
  creditsSummary,
  liveWorkspaceId,
  reserveCredits,
  settleCredits,
} from '#services/ai_credits'
import ClerkBackend, {
  type ClerkMembershipSnapshot,
  type ClerkOrganizationSnapshot,
  type ClerkSubscriptionItemSnapshot,
} from '#services/clerk_backend'
import {
  accountOfProject,
  accountOfWorkspace,
  limitsOfAccount,
  organizationEntitlements,
  planLimitsCache,
  rememberSessionClaims,
} from '#services/entitlements'
import { compileTimeoutMs } from '#services/plan_enforcement'
import { upsertClerkUser } from '#services/clerk_users'
import {
  forgetOrganizationSyncs,
  ORGANIZATION_SYNC_INTERVAL_MS,
  syncOrganizationFromClerk,
  syncOrganizationsFromClerk,
  USER_SYNC_LIMIT,
  WorkspaceSyncRateLimitedException,
} from '#services/team_catchup'
import { applyOrganizationEvent } from '#services/team_sync'
import { adminFakes, createAdmin, FakeClerkBackend, useAdminFakes } from '#tests/admin'
import { clerkTokenFor } from '#tests/clerk'
import { signWebhook } from '#tests/clerk_keys'
import { createUser, newClerkUserId, uniqueEmail } from '#tests/helpers'

// --- Charges utiles Clerk réalistes -----------------------------------------------------------

function newOrganizationId(): string {
  return `org_${randomUUID().replaceAll('-', '').slice(0, 24)}`
}

/** Objet `organization` d'un webhook Clerk. */
function organizationJson(id: string, name: string, createdBy: User | null) {
  return {
    object: 'organization',
    id,
    name,
    slug: name.toLowerCase().replaceAll(' ', '-'),
    image_url: 'https://img.clerk.com/org.png',
    has_image: false,
    max_allowed_memberships: 10,
    admin_delete_enabled: true,
    public_metadata: {},
    private_metadata: {},
    created_by: createdBy?.clerkUserId,
    created_at: Date.now(),
    updated_at: Date.now(),
  }
}

/** Objet `organization_membership` d'un webhook Clerk. */
function membershipJson(
  organization: ReturnType<typeof organizationJson>,
  clerkUserId: string,
  role: string,
) {
  return {
    object: 'organization_membership',
    id: `orgmem_${randomUUID().replaceAll('-', '')}`,
    role,
    role_name: role === 'org:admin' ? 'Admin' : 'Member',
    permissions: [],
    public_metadata: {},
    private_metadata: {},
    created_at: Date.now(),
    updated_at: Date.now(),
    organization,
    public_user_data: {
      identifier: `${clerkUserId}@example.com`,
      first_name: 'Ada',
      last_name: 'Lovelace',
      image_url: 'https://img.clerk.com/ada.png',
      has_image: false,
      user_id: clerkUserId,
    },
  }
}

async function send(
  client: ApiClient,
  type: string,
  data: Record<string, unknown>,
  options: { id?: string; timestamp?: number } = {},
) {
  const id = options.id ?? `msg_${randomUUID()}`
  const body = JSON.stringify({
    type,
    object: 'event',
    data,
    timestamp: options.timestamp ?? Date.now(),
    instance_id: 'ins_test',
    event_attributes: { http_request: { client_ip: '127.0.0.1', user_agent: 'test' } },
  })
  const response = await client
    .post('/api/v1/webhooks/clerk')
    .headers({ ...signWebhook(body, undefined, id), 'content-type': 'application/json' })
    .json(JSON.parse(body) as object)
  response.assertStatus(204)
  return response
}

interface Team {
  organization: ReturnType<typeof organizationJson>
  workspace: Workspace
  admin: User
  member: User
}

/** Abonnement d'organisation reflété (miroir `subscriptions`), plan `team` par défaut. */
async function subscribeTeam(organizationId: string, planSlug = 'team') {
  await Subscription.create({
    userId: null,
    clerkOrganizationId: organizationId,
    clerkSubscriptionItemId: `csi_${randomUUID()}`,
    planSlug,
    status: 'active',
    periodEnd: null,
  })
}

/**
 * Équipe créée par webhooks : organisation, un administrateur (créateur), un membre ; abonnée au
 * plan `team` sauf `paid: false` (sans plan actif, aucun projet ne peut y entrer).
 */
async function createTeam(
  client: ApiClient,
  name = 'Lab',
  options: { paid?: boolean } = {},
): Promise<Team> {
  const admin = await createUser({ email: uniqueEmail('admin') })
  const member = await createUser({ email: uniqueEmail('member') })
  const organization = organizationJson(newOrganizationId(), name, admin)
  await send(client, 'organization.created', organization)
  await send(
    client,
    'organizationMembership.created',
    membershipJson(organization, admin.clerkUserId, 'org:admin'),
  )
  await send(
    client,
    'organizationMembership.created',
    membershipJson(organization, member.clerkUserId, 'org:member'),
  )
  const workspace = await Workspace.findByOrFail('clerkOrganizationId', organization.id)
  if (options.paid !== false) await subscribeTeam(organization.id)
  return { organization, workspace, admin, member }
}

async function createTeamProject(client: ApiClient, team: Team, owner: User, name = 'Paper') {
  const response = await client
    .post('/api/v1/projects')
    .json({ name, workspaceId: team.workspace.id })
    .loginAs(owner)
  response.assertStatus(201)
  return Project.findOrFail(response.body().project.id as string)
}

async function roles(workspaceId: string): Promise<Record<string, string>> {
  const members = await WorkspaceMember.query().where('workspaceId', workspaceId)
  return Object.fromEntries(members.map((member) => [member.userId, member.role]))
}

async function projectRole(client: ApiClient, user: User, projectId: string) {
  const response = await client.get(`/api/v1/projects/${projectId}`).loginAs(user)
  return response.status() === 200 ? (response.body().project.role as string) : response.status()
}

async function setTeamRole(client: ApiClient, user: User, projectId: string, role: string) {
  const response = await client
    .put(`/api/v1/projects/${projectId}/team-access`)
    .json({ role })
    .loginAs(user)
  response.assertStatus(200)
}

// --- Synchronisation --------------------------------------------------------------------------

test.group('teams: organization webhooks', (group) => {
  useAdminFakes(group)

  test('one team workspace per organization, roles from Clerk, replays ignored', async ({
    client,
    assert,
  }) => {
    const team = await createTeam(client)
    assert.equal(team.workspace.type, 'team')
    assert.equal(team.workspace.name, 'Lab')
    assert.equal(team.workspace.ownerId, team.admin.id)
    assert.deepEqual(await roles(team.workspace.id), {
      [team.admin.id]: 'admin',
      [team.member.id]: 'member',
    })

    // Même événement relivré (même svix-id), puis même état sous un autre identifiant.
    const replay = membershipJson(team.organization, team.member.clerkUserId, 'org:member')
    await send(client, 'organizationMembership.created', replay, { id: 'msg_replayed' })
    await send(client, 'organizationMembership.created', replay, { id: 'msg_replayed' })
    await send(client, 'organization.created', team.organization)
    assert.lengthOf(await Workspace.query().where('clerkOrganizationId', team.organization.id), 1)
    assert.lengthOf(await WorkspaceMember.query().where('workspaceId', team.workspace.id), 2)

    await send(client, 'organization.updated', { ...team.organization, name: 'Lab 2' })
    await team.workspace.refresh()
    assert.equal(team.workspace.name, 'Lab 2')
    // Promotion par Clerk : le membre devient administrateur.
    await send(
      client,
      'organizationMembership.updated',
      membershipJson(team.organization, team.member.clerkUserId, 'org:admin'),
    )
    assert.equal((await roles(team.workspace.id))[team.member.id], 'admin')
  })

  test('memberships may arrive before their organization or their account', async ({
    client,
    assert,
  }) => {
    const admin = await createUser()
    const organization = organizationJson(newOrganizationId(), 'Early', admin)
    // Adhésion d'abord : l'organisation est connue par la charge utile de l'adhésion.
    await send(
      client,
      'organizationMembership.created',
      membershipJson(organization, admin.clerkUserId, 'org:admin'),
    )
    const workspace = await Workspace.findByOrFail('clerkOrganizationId', organization.id)
    assert.equal(workspace.name, 'Early')

    // Adhésion d'un compte que Kaxolax ne connaît pas encore : en attente dans le miroir.
    const clerkUserId = newClerkUserId()
    await send(
      client,
      'organizationMembership.created',
      membershipJson(organization, clerkUserId, 'org:member'),
    )
    assert.lengthOf(await WorkspaceMember.query().where('workspaceId', workspace.id), 1)
    const email = uniqueEmail('late')
    await send(client, 'user.created', {
      id: clerkUserId,
      object: 'user',
      first_name: 'Grace',
      last_name: 'Hopper',
      primary_email_address_id: 'idn_1',
      email_addresses: [
        { id: 'idn_1', email_address: email, verification: { status: 'verified' } },
      ],
    })
    const late = await User.findByOrFail('clerkUserId', clerkUserId)
    assert.equal((await roles(workspace.id))[late.id], 'member')
  })

  test('the most recent state wins whatever the delivery order', async ({ client, assert }) => {
    const team = await createTeam(client)
    const user = await createUser()
    const t0 = Date.now() + 1000
    const joined = membershipJson(team.organization, user.clerkUserId, 'org:member')
    // Retrait (plus récent) livré avant l'arrivée : l'arrivée en retard est ignorée.
    await send(client, 'organizationMembership.deleted', joined, { timestamp: t0 + 2000 })
    await send(client, 'organizationMembership.created', joined, { timestamp: t0 + 1000 })
    assert.notProperty(await roles(team.workspace.id), user.id)
    // Il revient plus tard : nouvelle adhésion plus récente.
    await send(client, 'organizationMembership.created', joined, { timestamp: t0 + 3000 })
    assert.equal((await roles(team.workspace.id))[user.id], 'member')
    // Un changement de rôle plus ancien ne revient pas en arrière.
    const promoted = membershipJson(team.organization, user.clerkUserId, 'org:admin')
    await send(client, 'organizationMembership.updated', promoted, { timestamp: t0 + 5000 })
    const demoted = membershipJson(team.organization, user.clerkUserId, 'org:member')
    await send(client, 'organizationMembership.updated', demoted, { timestamp: t0 + 4000 })
    assert.equal((await roles(team.workspace.id))[user.id], 'admin')
    const mirror = await ClerkOrganizationMembership.query()
      .where({ clerkOrganizationId: team.organization.id, clerkUserId: user.clerkUserId })
      .firstOrFail()
    assert.equal(mirror.role, 'org:admin')

    // Invitations : gérées par Clerk, rien à refléter.
    await send(client, 'organizationInvitation.created', {
      object: 'organization_invitation',
      id: 'orginv_1',
      email_address: uniqueEmail(),
      role: 'org:member',
      organization_id: team.organization.id,
      status: 'pending',
      created_at: Date.now(),
      updated_at: Date.now(),
      expires_at: Date.now() + 86_400_000,
    })
  })

  test('a removed member loses access, their team projects go to the workspace owner', async ({
    client,
    assert,
  }) => {
    const team = await createTeam(client)
    const own = await createTeamProject(client, team, team.member, 'Member paper')
    const shared = await createTeamProject(client, team, team.admin, 'Admin paper')
    // Invitation individuelle du membre sur un projet de l'équipe : elle reste après son départ.
    await ProjectMember.create({ projectId: shared.id, userId: team.member.id, role: 'reviewer' })

    await send(
      client,
      'organizationMembership.deleted',
      membershipJson(team.organization, team.member.clerkUserId, 'org:member'),
    )
    assert.notProperty(await roles(team.workspace.id), team.member.id)
    await own.refresh()
    assert.equal(own.ownerId, team.admin.id)
    assert.equal(own.workspaceId, team.workspace.id)
    assert.equal(await projectRole(client, team.member, own.id), 404)
    assert.equal(await projectRole(client, team.member, shared.id), 'reviewer')
    assert.equal(await projectRole(client, team.admin, own.id), 'owner')
    // Le service temps réel relit son rôle sur chaque projet de l'équipe (fermeture en < 2 s).
    assert.includeMembers(adminFakes.realtime.memberChanges, [
      `${own.id}:${team.member.id}`,
      `${shared.id}:${team.member.id}`,
      // Le responsable qui reçoit le projet voit aussi son rôle relu.
      `${own.id}:${team.admin.id}`,
    ])
  })

  test('a deleted organization moves its projects to their owners, nothing is lost', async ({
    client,
    assert,
  }) => {
    const team = await createTeam(client)
    const memberProject = await createTeamProject(client, team, team.member, 'Kept')
    const adminProject = await createTeamProject(client, team, team.admin, 'Also kept')
    const deletedAt = Date.now() + 5000
    await send(
      client,
      'organization.deleted',
      { object: 'organization', id: team.organization.id, deleted: true },
      { timestamp: deletedAt },
    )
    assert.isNull(await Workspace.find(team.workspace.id))
    await memberProject.refresh()
    await adminProject.refresh()
    const personalOf = async (user: User) =>
      (await Workspace.query().where({ ownerId: user.id, type: 'personal' }).firstOrFail()).id
    assert.equal(memberProject.workspaceId, await personalOf(team.member))
    assert.equal(adminProject.workspaceId, await personalOf(team.admin))
    assert.equal(await projectRole(client, team.member, memberProject.id), 'owner')
    // L'accès d'équipe disparaît : l'administrateur n'avait que lui sur ce projet.
    assert.equal(await projectRole(client, team.admin, memberProject.id), 404)
    assert.include(adminFakes.realtime.memberChanges, `${memberProject.id}:${team.admin.id}`)

    // Événements en retard après la suppression : rien ne renaît.
    await send(client, 'organization.updated', team.organization, { timestamp: deletedAt + 1000 })
    await send(
      client,
      'organizationMembership.created',
      membershipJson(team.organization, team.admin.clerkUserId, 'org:admin'),
      { timestamp: deletedAt + 2000 },
    )
    assert.lengthOf(await Workspace.query().where('clerkOrganizationId', team.organization.id), 0)
  })

  test('a deleted account hands its team projects over instead of deleting them', async ({
    client,
    assert,
  }) => {
    const team = await createTeam(client)
    const project = await createTeamProject(client, team, team.member, 'Survives')
    await send(client, 'user.deleted', {
      object: 'user',
      id: team.member.clerkUserId,
      deleted: true,
    })
    await project.refresh()
    assert.equal(project.ownerId, team.admin.id)
    assert.equal(project.workspaceId, team.workspace.id)
    assert.notProperty(await roles(team.workspace.id), team.member.id)
  })

  test('a deleted sole member leaves the team projects in the team for the next member', async ({
    client,
    assert,
  }) => {
    const admin = await createUser()
    const organization = organizationJson(newOrganizationId(), 'Solo', admin)
    await send(client, 'organization.created', organization)
    await send(
      client,
      'organizationMembership.created',
      membershipJson(organization, admin.clerkUserId, 'org:admin'),
    )
    const workspace = await Workspace.findByOrFail('clerkOrganizationId', organization.id)
    await subscribeTeam(organization.id)
    const team = { organization, workspace, admin, member: admin }
    const project = await createTeamProject(client, team, admin, 'Solo paper')

    // Seul membre local : personne pour recevoir le projet, qui reste dans l'équipe.
    await send(client, 'user.deleted', { object: 'user', id: admin.clerkUserId, deleted: true })
    const kept = await Project.findOrFail(project.id)
    assert.equal(kept.workspaceId, workspace.id)
    assert.equal(kept.ownerId, admin.id)

    // Un membre arrive (compte déjà connu ou créé plus tard) : il reprend le projet.
    const newcomer = await createUser()
    await send(
      client,
      'organizationMembership.created',
      membershipJson(organization, newcomer.clerkUserId, 'org:member'),
    )
    await kept.refresh()
    await workspace.refresh()
    assert.equal(workspace.ownerId, newcomer.id)
    assert.equal(kept.ownerId, newcomer.id)
    assert.equal(kept.workspaceId, workspace.id)
    assert.equal(await projectRole(client, newcomer, kept.id), 'owner')
    assert.include(adminFakes.realtime.memberChanges, `${kept.id}:${newcomer.id}`)
  })

  test('a dissolved team deletes the projects still owned by a deleted account', async ({
    client,
    assert,
  }) => {
    const admin = await createUser()
    const organization = organizationJson(newOrganizationId(), 'Gone', admin)
    await send(client, 'organization.created', organization)
    await send(
      client,
      'organizationMembership.created',
      membershipJson(organization, admin.clerkUserId, 'org:admin'),
    )
    const workspace = await Workspace.findByOrFail('clerkOrganizationId', organization.id)
    await subscribeTeam(organization.id)
    const team = { organization, workspace, admin, member: admin }
    const project = await createTeamProject(client, team, admin, 'Orphan')
    const documentIds = (
      (await db.from('documents').where('project_id', project.id).select('id')) as { id: string }[]
    ).map((row) => row.id)

    // Seul membre local supprimé : le projet reste dans l'équipe, à son nom.
    await send(client, 'user.deleted', { object: 'user', id: admin.clerkUserId, deleted: true })
    assert.isNotNull(await Project.find(project.id))

    // L'organisation est ensuite supprimée : le projet d'un compte supprimé n'est rattaché à aucun
    // workspace personnel recréé pour lui, il est supprimé (ressources libérées).
    await send(
      client,
      'organization.deleted',
      { object: 'organization', id: organization.id, deleted: true },
      { timestamp: Date.now() + 5000 },
    )
    assert.isNull(await Workspace.find(workspace.id))
    assert.isNull(await Project.find(project.id))
    assert.includeMembers(adminFakes.realtime.closed, documentIds)
    // Son workspace personnel (gardé vide à la suppression du compte) ne reçoit rien.
    const personal = await Workspace.query().where({ ownerId: admin.id, type: 'personal' })
    assert.lengthOf(personal, 1)
    for (const own of personal) {
      assert.lengthOf(await Project.query().where('workspaceId', own.id), 0)
    }
  })

  test('a banned creator is not the responsible: projects go to an active admin', async ({
    client,
    assert,
  }) => {
    const team = await createTeam(client)
    const other = await createUser()
    await send(
      client,
      'organizationMembership.created',
      membershipJson(team.organization, other.clerkUserId, 'org:admin'),
    )
    const project = await createTeamProject(client, team, team.member, 'Member paper')
    team.admin.bannedAt = DateTime.utc()
    await team.admin.save()

    // Compte du membre supprimé : ses projets d'équipe vont à l'administrateur actif.
    await send(client, 'user.deleted', {
      object: 'user',
      id: team.member.clerkUserId,
      deleted: true,
    })
    await project.refresh()
    assert.equal(project.ownerId, other.id)
    assert.equal(project.workspaceId, team.workspace.id)
    await team.workspace.refresh()
    assert.equal(team.workspace.ownerId, other.id)
  })

  test('a creator demoted to member stops being the responsible (least privilege)', async ({
    client,
    assert,
  }) => {
    const team = await createTeam(client)
    const other = await createUser()
    await send(
      client,
      'organizationMembership.created',
      membershipJson(team.organization, other.clerkUserId, 'org:admin'),
    )
    await send(
      client,
      'organizationMembership.updated',
      membershipJson(team.organization, team.admin.clerkUserId, 'org:member'),
    )
    await team.workspace.refresh()
    assert.equal(team.workspace.ownerId, other.id)

    const project = await createTeamProject(client, team, team.member, 'Member paper')
    await setTeamRole(client, other, project.id, 'reviewer')
    await send(
      client,
      'organizationMembership.deleted',
      membershipJson(team.organization, team.member.clerkUserId, 'org:member'),
    )
    await project.refresh()
    assert.equal(project.ownerId, other.id)
    // L'ancien créateur, simple membre, garde le rôle d'équipe du projet.
    assert.equal(await projectRole(client, team.admin, project.id), 'reviewer')
  })
})

// --- Accès ----------------------------------------------------------------------------------

test.group('teams: access', (group) => {
  useAdminFakes(group)

  test('team members reach the projects of the team with a derived role', async ({
    client,
    assert,
  }) => {
    const team = await createTeam(client)
    const outsider = await createUser()
    const project = await createTeamProject(client, team, team.member)
    assert.equal(await projectRole(client, team.member, project.id), 'owner')
    const adminProject = await createTeamProject(client, team, team.admin, 'Admin paper')
    assert.equal(await projectRole(client, team.member, adminProject.id), 'editor')
    // Administrateur de l'équipe : propriétaire effectif du projet d'un membre.
    assert.equal(await projectRole(client, team.admin, project.id), 'owner')
    ;(
      await client
        .patch(`/api/v1/projects/${project.id}`)
        .json({ name: 'Renamed by the admin' })
        .loginAs(team.admin)
    ).assertStatus(200)
    assert.equal(await projectRole(client, outsider, project.id), 404)

    // Le membre édite le projet de l'administrateur.
    ;(
      await client
        .post(`/api/v1/projects/${adminProject.id}/documents`)
        .json({ name: 'notes.tex', content: 'x' })
        .loginAs(team.member)
    ).assertStatus(201)
    const listed = await client
      .get('/api/v1/projects')
      .qs({ workspaceId: team.workspace.id })
      .loginAs(team.member)
    listed.assertStatus(200)
    assert.sameMembers(
      (listed.body().projects as { id: string }[]).map((entry) => entry.id),
      [project.id, adminProject.id],
    )
    ;(
      await client.get('/api/v1/projects').qs({ workspaceId: team.workspace.id }).loginAs(outsider)
    ).assertStatus(404)
  })

  test('the team role is set per project; individual invitations stay higher', async ({
    client,
    assert,
  }) => {
    const team = await createTeam(client)
    const project = await createTeamProject(client, team, team.admin)
    const update = (user: User, role: string) =>
      client.put(`/api/v1/projects/${project.id}/team-access`).json({ role }).loginAs(user)
    ;(await update(team.member, 'viewer')).assertStatus(403)
    const response = await update(team.admin, 'viewer')
    response.assertStatus(200)
    response.assertBody({
      access: { projectId: project.id, workspaceId: team.workspace.id, role: 'viewer' },
    })
    assert.equal(await projectRole(client, team.member, project.id), 'viewer')
    assert.include(adminFakes.realtime.memberChanges, `${project.id}:${team.member.id}`)
    ;(
      await client
        .post(`/api/v1/projects/${project.id}/documents`)
        .json({ name: 'refused.tex' })
        .loginAs(team.member)
    ).assertStatus(403)

    await ProjectMember.create({ projectId: project.id, userId: team.member.id, role: 'editor' })
    assert.equal(await projectRole(client, team.member, project.id), 'editor')
    const members = await client.get(`/api/v1/projects/${project.id}/members`).loginAs(team.admin)
    members.assertBodyContains({
      team: { workspaceId: team.workspace.id, memberRole: 'viewer', memberCount: 2 },
    })

    // Projet personnel : pas d'accès d'équipe.
    const personal = await client
      .post('/api/v1/projects')
      .json({ name: 'Mine' })
      .loginAs(team.admin)
    const personalId = personal.body().project.id as string
    ;(
      await client
        .put(`/api/v1/projects/${personalId}/team-access`)
        .json({ role: 'viewer' })
        .loginAs(team.admin)
    ).assertStatus(422)
  })

  test('GET /workspaces lists the teams; members are visible, emails to admins only', async ({
    client,
    assert,
  }) => {
    const team = await createTeam(client)
    const list = await client.get('/api/v1/workspaces').loginAs(team.member)
    list.assertStatus(200)
    const workspaces = list.body().workspaces as {
      id: string
      type: string
      role: string
      clerkOrganizationId: string | null
      memberCount: number
      slug: string | null
    }[]
    assert.deepEqual(
      workspaces.map((workspace) => workspace.type),
      ['personal', 'team'],
    )
    assert.deepInclude(workspaces[1], {
      id: team.workspace.id,
      role: 'member',
      clerkOrganizationId: team.organization.id,
      memberCount: 2,
      slug: 'lab',
    })

    const asMember = await client
      .get(`/api/v1/workspaces/${team.workspace.id}/members`)
      .loginAs(team.member)
    asMember.assertStatus(200)
    const seen = asMember.body().members as { user: { id: string; email: string | null } }[]
    assert.deepEqual(
      seen.map((entry) => [entry.user.id, entry.user.email]),
      [
        [team.admin.id, null],
        [team.member.id, team.member.email],
      ],
    )
    const asAdmin = await client
      .get(`/api/v1/workspaces/${team.workspace.id}/members`)
      .loginAs(team.admin)
    asAdmin.assertBodyContains({ members: [{ user: { email: team.admin.email }, role: 'admin' }] })
    ;(
      await client
        .get(`/api/v1/workspaces/${team.workspace.id}/members`)
        .loginAs(await createUser())
    ).assertStatus(404)
  })

  test('a personal project moves into a team, by its owner only', async ({ client, assert }) => {
    const team = await createTeam(client)
    const created = await client
      .post('/api/v1/projects')
      .json({ name: 'Thesis' })
      .loginAs(team.member)
    const projectId = created.body().project.id as string
    const move = (user: User, workspaceId: string) =>
      client.post(`/api/v1/projects/${projectId}/move`).json({ workspaceId }).loginAs(user)

    ;(await move(team.admin, team.workspace.id)).assertStatus(404)
    const personal = await Workspace.query()
      .where({ ownerId: team.member.id, type: 'personal' })
      .firstOrFail()
    ;(await move(team.member, personal.id)).assertStatus(422)
    ;(await move(team.member, randomUUID())).assertStatus(404)

    const moved = await move(team.member, team.workspace.id)
    moved.assertStatus(200)
    moved.assertBodyContains({ project: { id: projectId, workspaceId: team.workspace.id } })
    assert.equal(await projectRole(client, team.admin, projectId), 'owner')
    assert.include(adminFakes.realtime.memberChanges, `${projectId}:${team.admin.id}`)
    // Déjà dans l'équipe : plus rien à déplacer.
    const again = await move(team.member, team.workspace.id)
    again.assertStatus(422)
    again.assertBodyContains({ code: 'E_INVALID_PROJECT_MOVE' })
  })

  test('moving checks the limits of the plan of the team', async ({ client, assert }) => {
    const team = await createTeam(client, 'Lab', { paid: false })
    await db.table('plan_limits').insert({
      plan_slug: 'tiny_team',
      max_compile_seconds: 20,
      max_collaborators: 0,
      history_retention_days: 1,
      storage_bytes: 1,
    })
    planLimitsCache.clear()
    await subscribeTeam(team.organization.id, 'tiny_team')
    try {
      const created = await client
        .post('/api/v1/projects')
        .json({ name: 'Too big' })
        .loginAs(team.member)
      const projectId = created.body().project.id as string
      const refused = await client
        .post(`/api/v1/projects/${projectId}/move`)
        .json({ workspaceId: team.workspace.id })
        .loginAs(team.member)
      refused.assertStatus(403)
      refused.assertBodyContains({
        code: 'E_PLAN_LIMIT',
        limit: { name: 'storage', plan: 'tiny_team', max: 1 },
      })
      assert.notEqual((await Project.findOrFail(projectId)).workspaceId, team.workspace.id)
      // Création directe dans l'équipe : même stockage mutualisé, même refus.
      ;(
        await client
          .post('/api/v1/projects')
          .json({ name: 'Refused', workspaceId: team.workspace.id })
          .loginAs(team.member)
      ).assertStatus(403)
    } finally {
      planLimitsCache.clear()
    }
  })

  test('a team project is transferred within the team only', async ({ client, assert }) => {
    const team = await createTeam(client)
    const outsider = await createUser()
    const project = await createTeamProject(client, team, team.admin)
    await ProjectMember.create({ projectId: project.id, userId: outsider.id, role: 'editor' })
    const transfer = (userId: string) =>
      client.post(`/api/v1/projects/${project.id}/transfer`).json({ userId }).loginAs(team.admin)
    const refused = await transfer(outsider.id)
    refused.assertStatus(422)
    refused.assertBodyContains({ code: 'E_NEW_OWNER_NOT_IN_TEAM' })
    // Un membre de l'équipe (sans ligne de membre du projet) peut le recevoir.
    ;(await transfer(team.member.id)).assertStatus(200)
    await project.refresh()
    assert.equal(project.ownerId, team.member.id)
    assert.equal(project.workspaceId, team.workspace.id)
  })
})

// --- Facturation ------------------------------------------------------------------------------

test.group('teams: billing', (group) => {
  useAdminFakes(group)
  group.each.teardown(() => {
    planLimitsCache.clear()
  })

  test('team projects follow the plan of the organization, credits per seat', async ({
    client,
    assert,
  }) => {
    const team = await createTeam(client, 'Lab', { paid: false })
    const account = await accountOfWorkspace(team.workspace.id)
    assert.equal(account?.type, 'team')
    if (account?.type !== 'team') return

    // Sans abonnement : limites de Free, mais aucune part Free propre à l'organisation (ni
    // réserve de crédits, ni projet : sinon chaque organisation créée multiplierait les quotas).
    const free = await limitsOfAccount(account)
    assert.equal(free.entitlements.plan, 'free')
    assert.equal(free.aiCredits, 0)
    assert.equal(free.imageCredits, 0)
    const refused = await client
      .post('/api/v1/projects')
      .json({ name: 'Free ride', workspaceId: team.workspace.id })
      .loginAs(team.member)
    refused.assertStatus(403)
    refused.assertBodyContains({ code: 'E_TEAM_PLAN_REQUIRED' })
    const unpaidPlan = await client
      .get(`/api/v1/workspaces/${team.workspace.id}/plan`)
      .loginAs(team.member)
    unpaidPlan.assertBodyContains({ plan: 'free', active: false, credits: { ai: { monthly: 0 } } })

    await send(client, 'subscriptionItem.active', {
      object: 'commerce_subscription_item',
      id: `csi_${randomUUID()}`,
      status: 'active',
      plan_period: 'month',
      period_start: Date.now(),
      period_end: Date.now() + 30 * 86_400_000,
      plan: { id: 'cplan_team', name: 'Team', slug: 'team', is_default: false },
      payer: { organization_id: team.organization.id },
    })
    const project = await createTeamProject(client, team, team.member)
    assert.equal((await accountOfProject(project)).type, 'team')
    const limits = await limitsOfAccount(account)
    assert.equal(limits.entitlements.plan, 'team')
    assert.equal(limits.entitlements.source, 'subscription')
    assert.equal(limits.maxCompileSeconds, 240)
    assert.isNull(limits.maxCollaborators)
    assert.isNull(limits.historyRetentionDays)
    assert.equal(limits.storageBytes, 50 * 1024 * 1024 * 1024)
    assert.equal(limits.seats, 2)
    assert.isTrue(limits.perSeat)
    assert.equal(limits.aiCredits, 4000)
    assert.equal(limits.imageCredits, 200)
    // Le membre Free compile le projet d'équipe avec la limite du plan Team.
    assert.equal(await compileTimeoutMs(project, team.member), 240_000)
    const personal = await client
      .post('/api/v1/projects')
      .json({ name: 'Personal' })
      .loginAs(team.member)
    const personalProject = await Project.findOrFail(personal.body().project.id as string)
    assert.equal(await compileTimeoutMs(personalProject, team.member), 20_000)

    const plan = await client
      .get(`/api/v1/workspaces/${team.workspace.id}/plan`)
      .loginAs(team.member)
    plan.assertStatus(200)
    plan.assertBodyContains({
      plan: 'team',
      active: true,
      seats: 2,
      perSeat: true,
      credits: { ai: { monthly: 4000, used: 0 } },
      subscription: { status: 'active' },
    })
    const personalWorkspace = personalProject.workspaceId
    ;(
      await client.get(`/api/v1/workspaces/${personalWorkspace}/plan`).loginAs(team.member)
    ).assertStatus(404)
  })

  test('org-scoped claims of the active organization are read first', async ({
    client,
    assert,
  }) => {
    const team = await createTeam(client)
    rememberSessionClaims(team.member, {
      sub: team.member.clerkUserId,
      v: 2,
      pla: 'u:free,o:team',
      fea: 'o:long_compile,o:extra_storage,u:ai',
      o: { id: team.organization.id, rol: 'member', slg: 'lab' },
    })
    const fromClaims = await organizationEntitlements(team.organization.id, team.member)
    assert.equal(fromClaims.plan, 'team')
    assert.equal(fromClaims.source, 'claims')
    assert.sameMembers([...fromClaims.features], ['long_compile', 'extra_storage'])
    // Claims d'une autre organisation active : miroir (sans abonnement : Free).
    const other = await organizationEntitlements(newOrganizationId(), team.member)
    assert.equal(other.plan, 'free')
    assert.equal(other.source, 'default')
  })

  test('a zip import into a team is checked against the storage of the team', async ({
    client,
    assert,
  }) => {
    const team = await createTeam(client)
    // Stockage personnel (Free) du membre déjà plein.
    const personal = await client
      .post('/api/v1/projects')
      .json({ name: 'Full' })
      .loginAs(team.member)
    const personalId = personal.body().project.id as string
    await File.create({
      projectId: personalId,
      folderId: null,
      name: 'big.pdf',
      s3Key: `projects/${personalId}/files/${randomUUID()}`,
      sha256: 'a'.repeat(64),
      sizeBytes: 500 * 1024 * 1024,
      mimeType: 'application/pdf',
    })
    const start = (user: User, workspaceId?: string) =>
      client
        .post('/api/v1/imports')
        .json({
          filename: 'paper.zip',
          sizeBytes: 1024 * 1024,
          ...(workspaceId === undefined ? {} : { workspaceId }),
        })
        .loginAs(user)
    const refused = await start(team.member)
    refused.assertStatus(403)
    refused.assertBodyContains({ code: 'E_PLAN_LIMIT', limit: { name: 'storage', plan: 'free' } })
    // Vers l'équipe : stockage mutualisé de l'équipe (50 Gio), le personnel ne compte pas.
    ;(await start(team.member, team.workspace.id)).assertStatus(201)

    // Équipe sans plan actif : refus avant l'upload ; équipe d'autrui : 404.
    const unpaid = await createTeam(client, 'Unpaid', { paid: false })
    const noPlan = await start(unpaid.member, unpaid.workspace.id)
    noPlan.assertStatus(403)
    noPlan.assertBodyContains({ code: 'E_TEAM_PLAN_REQUIRED' })
    ;(await start(team.member, unpaid.workspace.id)).assertStatus(404)
    // Ni déplacement vers elle.
    const own = await client.post('/api/v1/projects').json({ name: 'Own' }).loginAs(unpaid.member)
    const move = await client
      .post(`/api/v1/projects/${own.body().project.id as string}/move`)
      .json({ workspaceId: unpaid.workspace.id })
      .loginAs(unpaid.member)
    move.assertStatus(403)
    move.assertBodyContains({ code: 'E_TEAM_PLAN_REQUIRED' })
    assert.lengthOf(await Project.query().where('workspaceId', unpaid.workspace.id), 0)
  })

  test('AI credits of a team project are charged to the team pool', async ({ client, assert }) => {
    // Plan d'équipe de 50 crédits par siège : 100 crédits pour les deux membres.
    await db.table('plan_limits').insert({
      plan_slug: 'pool_team',
      max_compile_seconds: 20,
      max_collaborators: 1,
      history_retention_days: 1,
      storage_bytes: 1024 * 1024 * 1024,
      ai_monthly_credits: 50,
      image_monthly_credits: 1,
      credits_per_seat: true,
    })
    planLimitsCache.clear()
    const team = await createTeam(client, 'Lab', { paid: false })
    await subscribeTeam(team.organization.id, 'pool_team')
    const project = await createTeamProject(client, team, team.admin)
    const workspace = {
      id: team.workspace.id,
      type: 'team',
      clerkOrganizationId: team.organization.id,
    }
    const account = await creditAccountFor(team.member, workspace)
    assert.deepEqual(account, await accountOfProject(project))
    // Un invité extérieur (lien de partage, invitation) consomme ses crédits personnels.
    const guest = await createUser()
    await ProjectMember.create({ projectId: project.id, userId: guest.id, role: 'reviewer' })
    assert.deepEqual(await creditAccountFor(guest, workspace), { type: 'user', id: guest.id })
    const reservation = await reserveCredits(team.member, 'ai', 300_000, { account })
    assert.equal(reservation.workspaceId, team.workspace.id)
    assert.equal(reservation.userId, team.member.id)
    await settleCredits(reservation, 250_000)
    const pooled = await creditsSummary(team.admin, { account })
    assert.equal(pooled.ai.used, 25)
    // La réserve personnelle du membre n'est pas touchée.
    const own = await creditsSummary(team.member)
    assert.equal(own.ai.used, 0)
    // Toute l'équipe partage la réserve : au-delà, refus pour tous ses membres.
    await settleCredits(await reserveCredits(team.admin, 'ai', 750_000, { account }), 750_000)
    await assert.rejects(() => reserveCredits(team.member, 'ai', 1, { account }))
    await reserveCredits(team.member, 'ai', 1)

    // Sans plan actif (abonnement terminé) : plus de réserve d'équipe, crédits de l'auteur.
    await Subscription.query()
      .where('clerkOrganizationId', team.organization.id)
      .update({ status: 'ended' })
    assert.deepEqual(await creditAccountFor(team.member, workspace), {
      type: 'user',
      id: team.member.id,
    })

    // Organisation supprimée : la consommation passée de l'équipe reste (pas de cascade).
    await send(
      client,
      'organization.deleted',
      { object: 'organization', id: team.organization.id, deleted: true },
      { timestamp: Date.now() + 5000 },
    )
    const kept = (await db
      .from('ai_credit_periods')
      .where('clerk_organization_id', team.organization.id)
      .select('workspace_id', 'ai_used_micros')) as {
      workspace_id: string | null
      ai_used_micros: string | number
    }[]
    assert.deepEqual(
      kept.map((row) => [row.workspace_id, Number(row.ai_used_micros)]),
      [[null, 1_000_000]],
    )
  })

  test('a call in progress when the team is dissolved is settled on the organization', async ({
    client,
    assert,
  }) => {
    const team = await createTeam(client, 'Lab')
    const workspace = {
      id: team.workspace.id,
      type: 'team',
      clerkOrganizationId: team.organization.id,
    }
    const account = await creditAccountFor(team.member, workspace)
    const first = await reserveCredits(team.member, 'ai', 200_000, { account })
    await settleCredits(first, 100_000)
    const inFlight = await reserveCredits(team.member, 'ai', 300_000, { account })
    assert.equal(inFlight.clerkOrganizationId, team.organization.id)

    // Dissolution pendant l'appel : réservation supprimée en cascade, agrégat détaché.
    await send(
      client,
      'organization.deleted',
      { object: 'organization', id: team.organization.id, deleted: true },
      { timestamp: Date.now() + 5000 },
    )
    await settleCredits(inFlight, 250_000)
    const rows = (await db
      .from('ai_credit_periods')
      .where('clerk_organization_id', team.organization.id)
      .select('workspace_id', 'user_id', 'ai_used_micros')) as {
      workspace_id: string | null
      user_id: string | null
      ai_used_micros: string | number
    }[]
    assert.deepEqual(
      rows.map((row) => [row.workspace_id, row.user_id, Number(row.ai_used_micros)]),
      [[null, null, 350_000]],
    )
    // La réserve personnelle de l'auteur n'est pas touchée.
    assert.equal((await creditsSummary(team.member)).ai.used, 0)
    assert.isNull(await db.transaction((trx) => liveWorkspaceId(team.workspace.id, trx)))
  })
})

// --- Admin et rattrapage ------------------------------------------------------------------------

class FakeOrganizationsClerk extends FakeClerkBackend {
  organizations: ClerkOrganizationSnapshot[] = []
  memberships = new Map<string, ClerkMembershipSnapshot[]>()
  items = new Map<string, ClerkSubscriptionItemSnapshot[]>()

  /** Lectures d'une organisation par l'API Backend simulée. */
  readonly organizationReads: string[] = []

  override listOrganizations(): Promise<ClerkOrganizationSnapshot[]> {
    return Promise.resolve(this.organizations)
  }

  override getOrganization(organizationId: string) {
    this.organizationReads.push(organizationId)
    return Promise.resolve(
      this.organizations.find((organization) => organization.id === organizationId) ?? null,
    )
  }

  override listOrganizationMemberships(organizationId: string) {
    return Promise.resolve(this.memberships.get(organizationId) ?? [])
  }

  override organizationSubscriptionItems(organizationId: string) {
    return Promise.resolve(this.items.get(organizationId) ?? null)
  }
}

test.group('teams: admin and catch-up', (group) => {
  useAdminFakes(group)

  test('the admin lists organizations with their plan', async ({ client, assert }) => {
    const { token } = await createAdmin(adminFakes.clerk)
    const team = await createTeam(client, 'Physics')
    await createTeamProject(client, team, team.member)
    await Subscription.create({
      userId: null,
      clerkOrganizationId: team.organization.id,
      clerkSubscriptionItemId: `csi_${randomUUID()}`,
      planSlug: 'team',
      status: 'active',
      periodEnd: null,
    })
    const response = await client
      .get('/api/v1/admin/organizations')
      .qs({ q: 'physics' })
      .bearerToken(token)
    response.assertStatus(200)
    response.assertBodyContains({
      organizations: [
        {
          workspaceId: team.workspace.id,
          clerkOrganizationId: team.organization.id,
          name: 'Physics',
          planSlug: 'team',
          subscriptionStatus: 'active',
          memberCount: 2,
          adminCount: 1,
          projectCount: 1,
          owner: { id: team.admin.id },
          deletedAt: null,
        },
      ],
      pagination: { total: 1 },
    })
    assert.isAbove(response.body().organizations[0].storageBytes as number, 0)
    ;(await client.get('/api/v1/admin/organizations').loginAs(team.admin)).assertStatus(403)
  })

  test('clerk:sync-organizations mirrors Clerk and is idempotent', async ({ client, assert }) => {
    const admin = await createUser()
    const member = await createUser()
    const stale = await createTeam(client, 'Gone')
    const leaving = await createUser()
    const organizationId = newOrganizationId()
    const clerk = new FakeOrganizationsClerk()
    clerk.organizations = [
      { id: organizationId, name: 'Synced', slug: 'synced', createdBy: admin.clerkUserId },
    ]
    clerk.memberships.set(organizationId, [
      { clerkUserId: admin.clerkUserId, role: 'org:admin' },
      { clerkUserId: member.clerkUserId, role: 'org:member' },
      { clerkUserId: leaving.clerkUserId, role: 'org:member' },
    ])
    clerk.items.set(organizationId, [
      {
        id: `csi_${randomUUID()}`,
        status: 'active',
        period_end: Date.now() + 86_400_000,
        plan: { slug: 'team', name: 'Team', is_default: false },
      },
    ])

    const first = await syncOrganizationsFromClerk(clerk)
    assert.equal(first.organizations, 1)
    assert.deepEqual(first.missing, [stale.organization.id])
    assert.isFalse(first.pruned)
    assert.isNotNull(await Workspace.find(stale.workspace.id))
    const workspace = await Workspace.findByOrFail('clerkOrganizationId', organizationId)
    assert.equal(workspace.ownerId, admin.id)
    assert.deepEqual(await roles(workspace.id), {
      [admin.id]: 'admin',
      [member.id]: 'member',
      [leaving.id]: 'member',
    })
    const subscription = await Subscription.findByOrFail('clerkOrganizationId', organizationId)
    assert.equal(subscription.planSlug, 'team')

    // Second passage : un membre a quitté l'organisation pendant que ses webhooks se perdaient.
    clerk.memberships.set(organizationId, [
      { clerkUserId: admin.clerkUserId, role: 'org:admin' },
      { clerkUserId: member.clerkUserId, role: 'org:member' },
    ])
    const second = await syncOrganizationsFromClerk(clerk, { prune: true })
    assert.isTrue(second.pruned)
    assert.notProperty(await roles(workspace.id), leaving.id)
    assert.lengthOf(await WorkspaceMember.query().where('workspaceId', workspace.id), 2)
    assert.isNull(await Workspace.find(stale.workspace.id))
    assert.lengthOf(await Workspace.query().where('clerkOrganizationId', organizationId), 1)

    const dry = await syncOrganizationsFromClerk(clerk, { dryRun: true })
    assert.equal(dry.memberships, 2)
  })

  test('--prune never deletes an organization created during the catch-up', async ({
    client,
    assert,
  }) => {
    const stale = await createTeam(client, 'Gone')
    const listed = await createTeam(client, 'Listed')
    let fresh: Team | null = null
    // Clerk lu pendant qu'une organisation y est créée : son webhook arrive pendant la lecture.
    class RacingClerk extends FakeOrganizationsClerk {
      override async listOrganizationMemberships(organizationId: string) {
        fresh ??= await createTeam(client, 'Fresh')
        return super.listOrganizationMemberships(organizationId)
      }
    }
    const clerk = new RacingClerk()
    clerk.organizations = [
      {
        id: listed.organization.id,
        name: 'Listed',
        slug: 'listed',
        createdBy: listed.admin.clerkUserId,
      },
    ]
    clerk.memberships.set(listed.organization.id, [
      { clerkUserId: listed.admin.clerkUserId, role: 'org:admin' },
      { clerkUserId: listed.member.clerkUserId, role: 'org:member' },
    ])
    const report = await syncOrganizationsFromClerk(clerk, { prune: true })
    assert.deepEqual(report.missing, [stale.organization.id])
    assert.isNull(await Workspace.find(stale.workspace.id))
    assert.isNotNull(fresh)
    const created = fresh as Team | null
    if (created === null) return
    assert.isNotNull(await Workspace.find(created.workspace.id))
    const mirror = await ClerkOrganization.findOrFail(created.organization.id)
    assert.isNull(mirror.deletedAt)
  })
})

test.group('teams: on-demand catch-up and admin detail', (group) => {
  useAdminFakes(group)
  group.each.setup(() => {
    forgetOrganizationSyncs()
  })

  /** Jeton de session dont l'organisation active est `organizationId` (claim `o` du jeton v2). */
  const activeOrganizationToken = (user: User, organizationId: string, role = 'org:member') =>
    clerkTokenFor(user, { v: 2, o: { id: organizationId, rol: role.replace('org:', '') } })

  test('POST /workspaces/sync mirrors the active organization from Clerk', async ({
    client,
    assert,
  }) => {
    const admin = await createUser()
    const member = await createUser()
    const outsider = await createUser()
    const organizationId = newOrganizationId()
    const clerk = new FakeOrganizationsClerk()
    app.container.swap(ClerkBackend, () => clerk)
    clerk.organizations = [
      { id: organizationId, name: 'Optics', slug: 'optics', createdBy: admin.clerkUserId },
    ]
    clerk.memberships.set(organizationId, [
      { clerkUserId: admin.clerkUserId, role: 'org:admin' },
      { clerkUserId: member.clerkUserId, role: 'org:member' },
    ])

    // Sans organisation active : rien à rattraper.
    const none = await client.post('/api/v1/workspaces/sync').loginAs(member)
    none.assertStatus(422)
    none.assertBodyContains({ code: 'E_NO_ACTIVE_ORGANIZATION' })

    const response = await client
      .post('/api/v1/workspaces/sync')
      .bearerToken(activeOrganizationToken(member, organizationId))
    response.assertStatus(200)
    response.assertBodyContains({
      workspace: {
        type: 'team',
        name: 'Optics',
        role: 'member',
        clerkOrganizationId: organizationId,
        slug: 'optics',
        memberCount: 2,
      },
    })
    const workspace = await Workspace.findByOrFail('clerkOrganizationId', organizationId)
    assert.equal(workspace.ownerId, admin.id)
    assert.deepEqual(await roles(workspace.id), { [admin.id]: 'admin', [member.id]: 'member' })

    // Appel répété dans l'intervalle : Clerk n'est pas relu, l'état local est renvoyé.
    const again = await client
      .post('/api/v1/workspaces/sync')
      .bearerToken(activeOrganizationToken(admin, organizationId, 'org:admin'))
    again.assertStatus(200)
    again.assertBodyContains({ workspace: { id: workspace.id, role: 'admin' } })
    assert.deepEqual(clerk.organizationReads, [organizationId])

    // Jeton d'une organisation dont Clerk ne connaît pas l'appelant : aucun workspace.
    forgetOrganizationSyncs()
    const foreign = await client
      .post('/api/v1/workspaces/sync')
      .bearerToken(activeOrganizationToken(outsider, organizationId))
    foreign.assertStatus(200)
    assert.isNull(foreign.body().workspace)
    assert.notProperty(await roles(workspace.id), outsider.id)
  })

  test('the on-demand catch-up applies removals and deletions, once per interval', async ({
    client,
    assert,
  }) => {
    const team = await createTeam(client, 'Acoustics')
    const project = await createTeamProject(client, team, team.member)
    const clerk = new FakeOrganizationsClerk()
    clerk.organizations = [
      {
        id: team.organization.id,
        name: 'Acoustics',
        slug: 'acoustics',
        createdBy: team.admin.clerkUserId,
      },
    ]
    // Le membre a quitté l'organisation, et le webhook s'est perdu.
    clerk.memberships.set(team.organization.id, [
      { clerkUserId: team.admin.clerkUserId, role: 'org:admin' },
    ])
    const now = Date.now()
    const effects = await syncOrganizationFromClerk(clerk, team.organization.id, team.admin.id, now)
    assert.isNotNull(effects)
    assert.deepEqual(await roles(team.workspace.id), { [team.admin.id]: 'admin' })
    assert.equal(await projectRole(client, team.member, project.id), 404)
    // Ses projets de l'équipe passent au responsable du workspace.
    await project.refresh()
    assert.equal(project.ownerId, team.admin.id)

    // Dans l'intervalle : rien n'est relu ; après : l'organisation supprimée chez Clerk l'est ici.
    clerk.organizations = []
    assert.isNull(
      await syncOrganizationFromClerk(clerk, team.organization.id, team.admin.id, now + 1_000),
    )
    assert.isNotNull(await Workspace.find(team.workspace.id))
    await syncOrganizationFromClerk(
      clerk,
      team.organization.id,
      team.admin.id,
      now + ORGANIZATION_SYNC_INTERVAL_MS,
    )
    assert.isNull(await Workspace.find(team.workspace.id))
    await project.refresh()
    assert.notEqual(project.workspaceId, team.workspace.id)
    // Organisation inconnue ici et chez Clerk : rien à faire.
    assert.deepEqual(await syncOrganizationFromClerk(clerk, newOrganizationId(), team.admin.id), {
      changes: [],
      deleted: [],
    })
  })

  test('the on-demand catch-up is limited per account across organizations', async ({
    client,
    assert,
  }) => {
    // Un compte qui multiplie les organisations (une lecture permise par organisation et par
    // intervalle) reste borné par compte : 429 au-delà, Clerk n'est plus appelé.
    const user = await createUser()
    const other = await createUser()
    const clerk = new FakeOrganizationsClerk()
    app.container.swap(ClerkBackend, () => clerk)
    const organizations = Array.from({ length: USER_SYNC_LIMIT + 1 }, () => newOrganizationId())
    const now = Date.now()
    for (const organizationId of organizations.slice(0, USER_SYNC_LIMIT)) {
      await syncOrganizationFromClerk(clerk, organizationId, user.id, now)
    }
    const last = organizations[USER_SYNC_LIMIT] ?? newOrganizationId()
    await assert.rejects(
      () => syncOrganizationFromClerk(clerk, last, user.id, now + 1_000),
      WorkspaceSyncRateLimitedException,
    )
    assert.lengthOf(clerk.organizationReads, USER_SYNC_LIMIT)
    // Un autre compte n'est pas touché ; le premier retrouve une lecture après la fenêtre.
    await syncOrganizationFromClerk(clerk, last, other.id, now + 1_000)
    forgetOrganizationSyncs()
    const response = await client
      .post('/api/v1/workspaces/sync')
      .bearerToken(activeOrganizationToken(user, last))
    response.assertStatus(200)
    for (const organizationId of organizations.slice(0, USER_SYNC_LIMIT - 1)) {
      await syncOrganizationFromClerk(clerk, organizationId, user.id)
    }
    const limited = await client
      .post('/api/v1/workspaces/sync')
      .bearerToken(activeOrganizationToken(user, newOrganizationId()))
    limited.assertStatus(429)
    limited.assertBodyContains({ code: 'E_WORKSPACE_SYNC_RATE_LIMITED' })
  })

  test('the admin opens an organization with its members and projects', async ({
    client,
    assert,
  }) => {
    const { token } = await createAdmin(adminFakes.clerk)
    const team = await createTeam(client, 'Geology')
    const project = await createTeamProject(client, team, team.member, 'Survey')
    const response = await client
      .get(`/api/v1/admin/organizations/${team.organization.id}`)
      .bearerToken(token)
    response.assertStatus(200)
    response.assertBodyContains({
      organization: {
        clerkOrganizationId: team.organization.id,
        name: 'Geology',
        planSlug: 'team',
        subscriptionStatus: 'active',
        memberCount: 2,
        projectCount: 1,
      },
      members: [
        { user: { id: team.admin.id }, role: 'admin' },
        { user: { id: team.member.id }, role: 'member' },
      ],
      projects: [{ id: project.id, name: 'Survey', owner: { id: team.member.id } }],
      projectTotal: 1,
    })
    assert.lengthOf(response.body().members as unknown[], 2)
    ;(
      await client.get(`/api/v1/admin/organizations/${newOrganizationId()}`).bearerToken(token)
    ).assertStatus(404)
    ;(
      await client.get(`/api/v1/admin/organizations/${team.organization.id}`).loginAs(team.admin)
    ).assertStatus(403)
  })
})

// --- Concurrence ------------------------------------------------------------------------------

test.group('teams: concurrency', () => {
  test('a membership written while the account is created is never lost', async ({
    assert,
    cleanup,
  }) => {
    // Hors transaction globale : chaque transaction a sa propre connexion.
    const admin = await createUser()
    const organization = organizationJson(newOrganizationId(), 'Race', admin)
    const clerkUserId = newClerkUserId()
    cleanup(async () => {
      await Workspace.query().where('clerkOrganizationId', organization.id).delete()
      await db
        .from('clerk_organization_memberships')
        .where('clerk_organization_id', organization.id)
        .delete()
      await db.from('clerk_organizations').where('clerk_organization_id', organization.id).delete()
      await User.query().whereIn('clerkUserId', [admin.clerkUserId, clerkUserId]).delete()
    })
    const apply = (type: string, data: unknown, trx: TransactionClientContract) =>
      applyOrganizationEvent({ type, data, timestamp: Date.now() }, trx)
    await db.transaction((trx) => apply('organization.created', organization, trx))
    await db.transaction((trx) =>
      apply(
        'organizationMembership.created',
        membershipJson(organization, admin.clerkUserId, 'org:admin'),
        trx,
      ),
    )

    // Invitation acceptée à l'inscription : l'adhésion s'écrit (pas encore validée) pendant que
    // `user.created` crée le compte dans une autre transaction.
    const membership = await db.transaction()
    await apply(
      'organizationMembership.created',
      membershipJson(organization, clerkUserId, 'org:member'),
      membership,
    )
    const creating = upsertClerkUser({
      clerkUserId,
      email: uniqueEmail('race'),
      fullName: null,
      avatarUrl: null,
    })
    await sleep(300)
    await membership.commit()
    const { user } = await creating

    const workspace = await Workspace.findByOrFail('clerkOrganizationId', organization.id)
    const member = await WorkspaceMember.query()
      .where({ workspaceId: workspace.id, userId: user.id })
      .first()
    assert.equal(member?.role, 'member')
  })
})
