import { randomUUID } from 'node:crypto'
import {
  invitationEmailMismatchErrorSchema,
  invitationPreviewSchema,
  invitationResponseSchema,
  joinProjectResponseSchema,
  memberResponseSchema,
  planLimitErrorSchema,
  projectInvitationsResponseSchema,
  projectMembersResponseSchema,
  type ProjectRole,
  shareLinkPreviewSchema,
  shareLinkResponseSchema,
  shareLinksResponseSchema,
  tooManyInvitationsErrorSchema,
} from '@kaxolax/contracts'
import app from '@adonisjs/core/services/app'
import db from '@adonisjs/lucid/services/db'
import testUtils from '@adonisjs/core/services/test_utils'
import mail from '@adonisjs/mail/services/main'
import { test } from '@japa/runner'
import type { ApiClient } from '@japa/api-client'
import { DateTime } from 'luxon'
import ProjectInvitationMail from '#mails/project_invitation_mail'
import Project from '#models/project'
import ProjectInvitation from '#models/project_invitation'
import ProjectMember from '#models/project_member'
import Subscription from '#models/subscription'
import User from '#models/user'
import Workspace from '#models/workspace'
import RealtimeClient from '#services/realtime_client'
import { inviteByEmail, revertInvitationSend } from '#services/sharing_service'
import { hashToken } from '#services/sharing_tokens'
import { sessionClaims, signJwt, signWebhook } from '#tests/clerk_keys'
import { createUser, newClerkUserId, uniqueEmail } from '#tests/helpers'

/** Service temps réel simulé : notifications de changement de membres enregistrées. */
class FakeRealtimeClient extends RealtimeClient {
  readonly changes: string[] = []

  override membersChanged(projectId: string, userIds: readonly string[]): Promise<void> {
    for (const userId of new Set(userIds)) this.changes.push(`${projectId}:${userId}`)
    return Promise.resolve()
  }

  override closeDocuments(): Promise<void> {
    return Promise.resolve()
  }
}

let realtime: FakeRealtimeClient
let mailer: ReturnType<typeof mail.fake>

async function newProject(client: ApiClient, owner: User, name = 'Thèse'): Promise<string> {
  const response = await client.post('/api/v1/projects').json({ name }).loginAs(owner)
  response.assertStatus(201)
  return response.body().project.id as string
}

async function addMember(projectId: string, role: ProjectRole, user?: User): Promise<User> {
  const member = user ?? (await createUser())
  await ProjectMember.create({ projectId, userId: member.id, role })
  return member
}

/** Jeton (en clair) du dernier email d'invitation envoyé à cette adresse. */
function lastInvitationToken(email: string): string {
  const sent = mailer.mails.sent(
    (candidate) =>
      candidate instanceof ProjectInvitationMail && candidate.data.to === email.toLowerCase(),
  )
  const last = sent.at(-1)
  if (!(last instanceof ProjectInvitationMail)) throw new Error(`no invitation sent to ${email}`)
  const token = last.data.url.split('/invitations/')[1]
  if (!token) throw new Error('malformed invitation url')
  return token
}

async function invite(
  client: ApiClient,
  owner: User,
  projectId: string,
  email: string,
  role: ProjectRole = 'editor',
) {
  return client
    .post(`/api/v1/projects/${projectId}/invitations`)
    .json({ email, role })
    .loginAs(owner)
}

/** Actions journalisées pour un projet, dans l'ordre. */
async function sharingEvents(projectId: string): Promise<string[]> {
  const rows = (await db
    .from('project_sharing_events')
    .where('project_id', projectId)
    .orderBy('created_at')
    .orderBy('id')
    .select('action')) as { action: string }[]
  return rows.map((row) => row.action)
}

async function roleOf(projectId: string, userId: string): Promise<ProjectRole | null> {
  const member = await ProjectMember.query().where({ projectId, userId }).first()
  return member?.role ?? null
}

/** Abonnement Pro actif : collaborateurs illimités (plan_limits). */
async function subscribePro(user: User): Promise<void> {
  await Subscription.create({
    userId: user.id,
    clerkSubscriptionItemId: `csi_${randomUUID()}`,
    planSlug: 'pro',
    status: 'active',
    periodEnd: null,
  })
}

function useSharingFakes(group: Parameters<Parameters<typeof test.group>[1]>[0]) {
  group.each.setup(() => testUtils.db().wrapInGlobalTransaction())
  group.each.setup(() => {
    realtime = new FakeRealtimeClient()
    app.container.swap(RealtimeClient, () => realtime)
    mailer = mail.fake()
    return () => {
      app.container.restore(RealtimeClient)
      mail.restore()
    }
  })
}

test.group('sharing: invitations', (group) => {
  useSharingFakes(group)

  test('the owner invites by email; the French email links to the invitation page', async ({
    client,
    assert,
  }) => {
    const owner = await createUser()
    const projectId = await newProject(client, owner, 'Thèse de Grace')
    const email = uniqueEmail('Grace').toUpperCase()

    const response = await invite(client, owner, projectId, email, 'reviewer')
    response.assertStatus(201)
    const { invitation } = invitationResponseSchema.parse(response.body())
    assert.equal(invitation.email, email.toLowerCase())
    assert.equal(invitation.role, 'reviewer')
    assert.isFalse(invitation.expired)
    const days = DateTime.fromISO(invitation.expiresAt).diff(DateTime.utc(), 'days').days
    assert.closeTo(days, 7, 0.01)

    const token = lastInvitationToken(email)
    const sent = mailer.mails.sent()[0]
    assert.instanceOf(sent, ProjectInvitationMail)
    if (sent instanceof ProjectInvitationMail) {
      assert.equal(sent.data.url, `http://localhost:3000/invitations/${token}`)
      // Message déjà construit par l'envoi.
      assert.include(sent.message.toJSON().message.text, 'vous invite à rejoindre')
    }
    // Seul le hash du jeton est stocké.
    const stored = await ProjectInvitation.findOrFail(invitation.id)
    assert.equal(stored.tokenHash, hashToken(token))
    assert.notInclude(JSON.stringify(stored.$attributes), token)
  })

  test('only the owner invites; other roles get 403 and strangers 404', async ({ client }) => {
    const owner = await createUser()
    await subscribePro(owner)
    const projectId = await newProject(client, owner)
    for (const role of ['editor', 'reviewer', 'viewer'] as const) {
      const member = await addMember(projectId, role)
      const refused = await invite(client, member, projectId, uniqueEmail())
      refused.assertStatus(403)
      refused.assertBodyContains({ code: 'E_PROJECT_FORBIDDEN' })
    }
    ;(await invite(client, await createUser(), projectId, uniqueEmail())).assertStatus(404)
    ;(await invite(client, owner, projectId, 'not-an-email')).assertStatus(422)
    ;(await invite(client, owner, projectId, uniqueEmail(), 'owner')).assertStatus(422)
  })

  test('refuses to invite an existing member', async ({ client }) => {
    const owner = await createUser()
    const projectId = await newProject(client, owner)
    const member = await addMember(projectId, 'viewer')
    const response = await invite(client, owner, projectId, member.email.toUpperCase())
    response.assertStatus(409)
    response.assertBodyContains({ code: 'E_ALREADY_MEMBER' })
  })

  test('applies the collaborator limit of the owner plan (free: 1, pro: unlimited)', async ({
    client,
    assert,
  }) => {
    const owner = await createUser()
    const projectId = await newProject(client, owner)
    ;(await invite(client, owner, projectId, uniqueEmail())).assertStatus(201)

    const refused = await invite(client, owner, projectId, uniqueEmail())
    refused.assertStatus(403)
    const body = planLimitErrorSchema.parse(refused.body())
    assert.deepEqual(body.limit, { name: 'collaborators', plan: 'free', max: 1 })

    // Un membre (autre que le propriétaire) occupe aussi une place.
    const other = await createUser()
    const otherProject = await newProject(client, other)
    await addMember(otherProject, 'viewer')
    ;(await invite(client, other, otherProject, uniqueEmail())).assertStatus(403)

    // Une invitation expirée ne réserve plus de place.
    await ProjectInvitation.query()
      .where('projectId', projectId)
      .update({ expiresAt: DateTime.utc().minus({ minutes: 1 }).toJSDate() })
    ;(await invite(client, owner, projectId, uniqueEmail())).assertStatus(201)

    await subscribePro(owner)
    ;(await invite(client, owner, projectId, uniqueEmail())).assertStatus(201)
    const members = projectMembersResponseSchema.parse(
      (await client.get(`/api/v1/projects/${projectId}/members`).loginAs(owner)).body(),
    )
    assert.deepEqual(members.collaborators, { plan: 'pro', max: null, used: 2 })
  })

  test('re-inviting a pending email updates its role and resends it, rate limited', async ({
    client,
    assert,
  }) => {
    const owner = await createUser()
    const projectId = await newProject(client, owner)
    const email = uniqueEmail()
    const first = invitationResponseSchema.parse(
      (await invite(client, owner, projectId, email, 'viewer')).body(),
    ).invitation
    const tooSoon = await invite(client, owner, projectId, email, 'editor')
    tooSoon.assertStatus(429)
    assert.isAbove(tooManyInvitationsErrorSchema.parse(tooSoon.body()).retryAfterSeconds ?? 0, 0)

    await ProjectInvitation.query()
      .where('id', first.id)
      .update({ lastSentAt: DateTime.utc().minus({ minutes: 2 }).toJSDate() })
    const again = await invite(client, owner, projectId, email, 'editor')
    again.assertStatus(200)
    const updated = invitationResponseSchema.parse(again.body()).invitation
    assert.equal(updated.id, first.id)
    assert.equal(updated.role, 'editor')
  })

  test('resends with a new token, a new expiry and a frequency limit', async ({
    client,
    assert,
  }) => {
    const owner = await createUser()
    const projectId = await newProject(client, owner)
    const email = uniqueEmail()
    const { invitation } = invitationResponseSchema.parse(
      (await invite(client, owner, projectId, email)).body(),
    )
    const oldToken = lastInvitationToken(email)
    const resend = () =>
      client
        .post(`/api/v1/projects/${projectId}/invitations/${invitation.id}/resend`)
        .loginAs(owner)

    const tooSoon = await resend()
    tooSoon.assertStatus(429)
    tooSoon.assertBodyContains({ code: 'E_TOO_MANY_INVITATIONS' })

    await ProjectInvitation.query()
      .where('id', invitation.id)
      .update({
        lastSentAt: DateTime.utc().minus({ minutes: 2 }).toJSDate(),
        expiresAt: DateTime.utc().minus({ days: 1 }).toJSDate(),
      })
    ;(await client.get(`/api/v1/invitations/${oldToken}`)).assertStatus(410)
    const resent = await resend()
    resent.assertStatus(200)
    assert.isFalse(invitationResponseSchema.parse(resent.body()).invitation.expired)
    const newToken = lastInvitationToken(email)
    assert.notEqual(newToken, oldToken)
    ;(await client.get(`/api/v1/invitations/${oldToken}`)).assertStatus(404)
    ;(await client.get(`/api/v1/invitations/${newToken}`)).assertStatus(200)

    await ProjectInvitation.query()
      .where('id', invitation.id)
      .update({ sendCount: 10, lastSentAt: DateTime.utc().minus({ hours: 1 }).toJSDate() })
    const exhausted = await resend()
    exhausted.assertStatus(429)
    assert.isNull(tooManyInvitationsErrorSchema.parse(exhausted.body()).retryAfterSeconds)
  })

  test('lists and cancels pending invitations (owner only)', async ({ client, assert }) => {
    const owner = await createUser()
    const projectId = await newProject(client, owner)
    const email = uniqueEmail()
    const { invitation } = invitationResponseSchema.parse(
      (await invite(client, owner, projectId, email)).body(),
    )
    const token = lastInvitationToken(email)
    const listed = projectInvitationsResponseSchema.parse(
      (await client.get(`/api/v1/projects/${projectId}/invitations`).loginAs(owner)).body(),
    )
    assert.deepEqual(
      listed.invitations.map((entry) => entry.id),
      [invitation.id],
    )
    const editor = await addMember(projectId, 'editor', undefined)
    ;(await client.get(`/api/v1/projects/${projectId}/invitations`).loginAs(editor)).assertStatus(
      403,
    )
    ;(
      await client
        .delete(`/api/v1/projects/${projectId}/invitations/${invitation.id}`)
        .loginAs(editor)
    ).assertStatus(403)

    ;(
      await client
        .delete(`/api/v1/projects/${projectId}/invitations/${invitation.id}`)
        .loginAs(owner)
    ).assertStatus(204)
    ;(await client.get(`/api/v1/invitations/${token}`)).assertStatus(404)
    ;(
      await client
        .delete(`/api/v1/projects/${projectId}/invitations/${invitation.id}`)
        .loginAs(owner)
    ).assertStatus(404)
  })

  test('shows a minimal public preview without leaking anything else', async ({
    client,
    assert,
  }) => {
    const owner = await createUser()
    const projectId = await newProject(client, owner, 'Article')
    const email = uniqueEmail()
    await invite(client, owner, projectId, email, 'viewer')
    const token = lastInvitationToken(email)

    const response = await client.get(`/api/v1/invitations/${token}`)
    response.assertStatus(200)
    const preview = invitationPreviewSchema.parse(response.body())
    assert.deepEqual(Object.keys(response.body() as object).sort(), [
      'accepted',
      'expiresAt',
      'inviterName',
      'projectName',
      'role',
    ])
    assert.equal(preview.projectName, 'Article')
    assert.equal(preview.inviterName, 'Ada Lovelace')
    assert.equal(preview.role, 'viewer')
    assert.isFalse(preview.accepted)
    assert.notInclude(JSON.stringify(response.body()), owner.email)

    ;(await client.get('/api/v1/invitations/garbage')).assertStatus(404)
    ;(await client.get(`/api/v1/invitations/${'a'.repeat(43)}`)).assertStatus(404)
  })

  test('accepts for the signed-in account whose verified email matches', async ({
    client,
    assert,
  }) => {
    const owner = await createUser()
    const projectId = await newProject(client, owner)
    const invitee = await createUser()
    await invite(client, owner, projectId, invitee.email, 'reviewer')
    const token = lastInvitationToken(invitee.email)

    const stranger = await createUser()
    const mismatch = await client.post(`/api/v1/invitations/${token}/accept`).loginAs(stranger)
    mismatch.assertStatus(403)
    const hint = invitationEmailMismatchErrorSchema.parse(mismatch.body()).invitedEmailHint
    assert.equal(hint, `${invitee.email[0] ?? ''}***@example.com`)
    assert.isNull(await roleOf(projectId, stranger.id))

    const accepted = await client.post(`/api/v1/invitations/${token}/accept`).loginAs(invitee)
    accepted.assertStatus(200)
    assert.deepEqual(joinProjectResponseSchema.parse(accepted.body()), {
      projectId,
      role: 'reviewer',
      joined: true,
    })
    assert.equal(await roleOf(projectId, invitee.id), 'reviewer')
    assert.deepEqual(await sharingEvents(projectId), ['invitation.created', 'invitation.accepted'])

    // Idempotente pour le compte invité ; 404 pour les autres une fois acceptée.
    const again = await client.post(`/api/v1/invitations/${token}/accept`).loginAs(invitee)
    again.assertStatus(200)
    assert.deepEqual(joinProjectResponseSchema.parse(again.body()), {
      projectId,
      role: 'reviewer',
      joined: false,
    })
    ;(await client.post(`/api/v1/invitations/${token}/accept`).loginAs(stranger)).assertStatus(404)
    ;(await client.post(`/api/v1/invitations/${token}/accept`)).assertStatus(401)

    // Retiré du projet depuis : l'invitation ne vaut plus rien.
    await ProjectMember.query().where({ projectId, userId: invitee.id }).delete()
    ;(await client.post(`/api/v1/invitations/${token}/accept`).loginAs(invitee)).assertStatus(404)
  })

  test('cancelling keeps the sending limits: invite, cancel, invite is rate limited', async ({
    client,
    assert,
  }) => {
    const owner = await createUser()
    const projectId = await newProject(client, owner)
    const email = uniqueEmail()
    const { invitation } = invitationResponseSchema.parse(
      (await invite(client, owner, projectId, email)).body(),
    )
    const cancelled = lastInvitationToken(email)
    const cancel = () =>
      client.delete(`/api/v1/projects/${projectId}/invitations/${invitation.id}`).loginAs(owner)
    ;(await cancel()).assertStatus(204)
    const listed = projectInvitationsResponseSchema.parse(
      (await client.get(`/api/v1/projects/${projectId}/invitations`).loginAs(owner)).body(),
    )
    assert.deepEqual(listed.invitations, [])

    // Réinviter aussitôt : même délai qu'une relance, aucun email.
    const tooSoon = await invite(client, owner, projectId, email)
    tooSoon.assertStatus(429)
    assert.lengthOf(mailer.mails.sent(), 1)

    await ProjectInvitation.query()
      .where('id', invitation.id)
      .update({ lastSentAt: DateTime.utc().minus({ minutes: 2 }).toJSDate() })
    const again = await invite(client, owner, projectId, email, 'viewer')
    again.assertStatus(201)
    const reactivated = invitationResponseSchema.parse(again.body()).invitation
    assert.equal(reactivated.id, invitation.id)
    assert.equal(reactivated.role, 'viewer')
    const stored = await ProjectInvitation.findOrFail(invitation.id)
    assert.equal(stored.sendCount, 2)
    assert.isNull(stored.cancelledAt)
    ;(await client.get(`/api/v1/invitations/${cancelled}`)).assertStatus(404)
    ;(await client.get(`/api/v1/invitations/${lastInvitationToken(email)}`)).assertStatus(200)

    // Le nombre maximal d'envois survit à l'annulation.
    ;(await cancel()).assertStatus(204)
    await ProjectInvitation.query()
      .where('id', invitation.id)
      .update({ sendCount: 10, lastSentAt: DateTime.utc().minus({ hours: 1 }).toJSDate() })
    const exhausted = await invite(client, owner, projectId, email)
    exhausted.assertStatus(429)
    assert.isNull(tooManyInvitationsErrorSchema.parse(exhausted.body()).retryAfterSeconds)
    assert.deepEqual(await sharingEvents(projectId), [
      'invitation.created',
      'invitation.cancelled',
      'invitation.created',
      'invitation.cancelled',
    ])
  })

  test('the hourly limit counts cancelled invitations, across projects', async ({ client }) => {
    const owner = await createUser()
    await subscribePro(owner)
    const projectId = await newProject(client, owner)
    const other = await newProject(client, owner, 'Autre')
    for (let index = 0; index < 30; index += 1) {
      await ProjectInvitation.create({
        projectId: index % 2 === 0 ? projectId : other,
        email: uniqueEmail(`bulk${String(index)}`).toLowerCase(),
        role: 'viewer',
        tokenHash: hashToken(randomUUID()),
        invitedBy: owner.id,
        expiresAt: DateTime.utc().plus({ days: 7 }),
        acceptedAt: null,
        cancelledAt: index < 20 ? DateTime.utc() : null,
        lastSentAt: DateTime.utc(),
        sendCount: 1,
      })
    }
    const refused = await invite(client, owner, other, uniqueEmail())
    refused.assertStatus(429)
    refused.assertBodyContains({ code: 'E_TOO_MANY_INVITATIONS' })
  })

  test('a failed email reverts the send: previous link valid, send not counted', async ({
    client,
    assert,
  }) => {
    const owner = await createUser()
    const projectId = await newProject(client, owner)
    const email = uniqueEmail()

    // Création : l'invitation disparaît, sa place et son quota sont rendus.
    const created = await inviteByEmail(owner, projectId, { email, role: 'editor' })
    await revertInvitationSend(created)
    assert.isNull(await ProjectInvitation.find(created.invitation.id))

    // Renvoi : l'ancien jeton refonctionne, compteurs et rôle d'avant.
    await invite(client, owner, projectId, email, 'viewer')
    const token = lastInvitationToken(email)
    const before = await ProjectInvitation.query().where({ projectId, email }).firstOrFail()
    await ProjectInvitation.query()
      .where('id', before.id)
      .update({ lastSentAt: DateTime.utc().minus({ minutes: 2 }).toJSDate() })
    const resent = await inviteByEmail(owner, projectId, { email, role: 'editor' })
    ;(await client.get(`/api/v1/invitations/${token}`)).assertStatus(404)
    await revertInvitationSend(resent)
    const after = await ProjectInvitation.findOrFail(before.id)
    assert.equal(after.sendCount, 1)
    assert.equal(after.role, 'viewer')
    assert.equal(after.tokenHash, hashToken(token))
    assert.isBelow(after.lastSentAt.diffNow('minutes').minutes, -1)
    ;(await client.get(`/api/v1/invitations/${token}`)).assertStatus(200)
    ;(await invite(client, owner, projectId, email)).assertStatus(200)
  })

  test('refuses an expired invitation and keeps the higher role of a member', async ({
    client,
    assert,
  }) => {
    const owner = await createUser()
    await subscribePro(owner)
    const projectId = await newProject(client, owner)
    const editor = await addMember(projectId, 'editor')
    const late = await createUser()
    await invite(client, owner, projectId, late.email)
    const lateToken = lastInvitationToken(late.email)
    await ProjectInvitation.query()
      .where('email', late.email)
      .update({ expiresAt: DateTime.utc().minus({ seconds: 1 }).toJSDate() })
    const expired = await client.post(`/api/v1/invitations/${lateToken}/accept`).loginAs(late)
    expired.assertStatus(410)
    expired.assertBodyContains({ code: 'E_INVITATION_EXPIRED' })

    // Invitation créée avant que la personne ne devienne membre par un autre chemin.
    const token = 'b'.repeat(43)
    await ProjectInvitation.create({
      projectId,
      email: editor.email,
      role: 'viewer',
      tokenHash: hashToken(token),
      invitedBy: owner.id,
      expiresAt: DateTime.utc().plus({ days: 1 }),
      acceptedAt: null,
      lastSentAt: DateTime.utc(),
      sendCount: 1,
    })
    const kept = await client.post(`/api/v1/invitations/${token}/accept`).loginAs(editor)
    kept.assertStatus(200)
    assert.deepEqual(joinProjectResponseSchema.parse(kept.body()), {
      projectId,
      role: 'editor',
      joined: false,
    })
    assert.equal(await roleOf(projectId, editor.id), 'editor')
  })
})

test.group('sharing: automatic acceptance at sign-up', (group) => {
  useSharingFakes(group)

  test('joins pending projects when the Clerk mirror is created on the fly', async ({
    client,
    assert,
  }) => {
    const owner = await createUser()
    await subscribePro(owner)
    const first = await newProject(client, owner, 'Un')
    const second = await newProject(client, owner, 'Deux')
    const expiredProject = await newProject(client, owner, 'Trois')
    const email = uniqueEmail('newcomer')
    await invite(client, owner, first, email, 'editor')
    const invitationToken = lastInvitationToken(email)
    await invite(client, owner, second, email, 'viewer')
    await invite(client, owner, expiredProject, email, 'viewer')
    await ProjectInvitation.query()
      .where({ projectId: expiredProject, email })
      .update({ expiresAt: DateTime.utc().minus({ minutes: 1 }).toJSDate() })

    const clerkUserId = newClerkUserId()
    const token = signJwt(
      sessionClaims(clerkUserId, { email, email_verified: true, name: 'New Comer' }),
    )
    ;(await client.get('/api/v1/me').bearerToken(token)).assertStatus(200)

    const user = await User.findByOrFail('clerkUserId', clerkUserId)
    // La page d'invitation, rouverte après l'inscription, retrouve le projet.
    const preview = invitationPreviewSchema.parse(
      (await client.get(`/api/v1/invitations/${invitationToken}`)).body(),
    )
    assert.isTrue(preview.accepted)
    const accepted = await client
      .post(`/api/v1/invitations/${invitationToken}/accept`)
      .bearerToken(token)
    accepted.assertStatus(200)
    assert.deepEqual(joinProjectResponseSchema.parse(accepted.body()), {
      projectId: first,
      role: 'editor',
      joined: false,
    })
    assert.equal(await roleOf(first, user.id), 'editor')
    assert.equal(await roleOf(second, user.id), 'viewer')
    assert.isNull(await roleOf(expiredProject, user.id))
    const pending = await ProjectInvitation.query().where('email', email).whereNull('acceptedAt')
    assert.deepEqual(
      pending.map((invitation) => invitation.projectId),
      [expiredProject],
    )
  })

  test('joins pending projects from the user.created webhook, within the plan limit', async ({
    client,
    assert,
  }) => {
    const owner = await createUser()
    const projectId = await newProject(client, owner)
    const email = uniqueEmail('webhook')
    await invite(client, owner, projectId, email, 'reviewer')
    // Plan Free plein entre-temps (membre ajouté par un autre chemin) : l'invitation attend.
    const full = await createUser()
    const fullProject = await newProject(client, full)
    const fullEmail = uniqueEmail('full')
    await invite(client, full, fullProject, fullEmail)
    await addMember(fullProject, 'viewer')

    const send = async (address: string) => {
      const clerkUserId = newClerkUserId()
      const body = JSON.stringify({
        type: 'user.created',
        object: 'event',
        timestamp: Date.now(),
        data: {
          id: clerkUserId,
          object: 'user',
          first_name: 'Grace',
          last_name: 'Hopper',
          primary_email_address_id: 'idn_1',
          email_addresses: [
            { id: 'idn_1', email_address: address, verification: { status: 'verified' } },
          ],
        },
      })
      const response = await client
        .post('/api/v1/webhooks/clerk')
        .headers({ ...signWebhook(body), 'content-type': 'application/json' })
        .json(JSON.parse(body) as object)
      response.assertStatus(204)
      return User.findByOrFail('clerkUserId', clerkUserId)
    }

    const user = await send(email)
    assert.equal(await roleOf(projectId, user.id), 'reviewer')
    const waiting = await send(fullEmail)
    assert.isNull(await roleOf(fullProject, waiting.id))
    assert.isNotNull(
      await ProjectInvitation.query().where('email', fullEmail).whereNull('acceptedAt').first(),
    )
  })
})

test.group('sharing: members', (group) => {
  useSharingFakes(group)

  test('lists members for every member, invitations and usage for the owner only', async ({
    client,
    assert,
  }) => {
    const owner = await createUser()
    await subscribePro(owner)
    const projectId = await newProject(client, owner)
    const viewer = await addMember(projectId, 'viewer')
    const editor = await addMember(projectId, 'editor')
    await invite(client, owner, projectId, uniqueEmail())

    const forOwner = projectMembersResponseSchema.parse(
      (await client.get(`/api/v1/projects/${projectId}/members`).loginAs(owner)).body(),
    )
    assert.deepEqual(
      forOwner.members.map((member) => [member.user.id, member.role]),
      [
        [owner.id, 'owner'],
        [editor.id, 'editor'],
        [viewer.id, 'viewer'],
      ],
    )
    assert.lengthOf(forOwner.invitations, 1)
    assert.deepEqual(forOwner.collaborators, { plan: 'pro', max: null, used: 3 })

    const forViewer = projectMembersResponseSchema.parse(
      (await client.get(`/api/v1/projects/${projectId}/members`).loginAs(viewer)).body(),
    )
    assert.lengthOf(forViewer.members, 3)
    // Emails : tous pour le propriétaire ; pour les autres rôles, seulement le sien.
    assert.deepEqual(
      forOwner.members.map((member) => member.user.email),
      [owner.email, editor.email, viewer.email],
    )
    assert.deepEqual(
      forViewer.members.map((member) => member.user.email),
      [null, null, viewer.email],
    )
    assert.notInclude(JSON.stringify(forViewer), owner.email)
    assert.deepEqual(forViewer.invitations, [])
    assert.isNull(forViewer.collaborators)
    ;(
      await client.get(`/api/v1/projects/${projectId}/members`).loginAs(await createUser())
    ).assertStatus(404)
  })

  test('the owner changes a role and the realtime service is notified', async ({
    client,
    assert,
  }) => {
    const owner = await createUser()
    const projectId = await newProject(client, owner)
    const editor = await addMember(projectId, 'editor')
    const patch = (as: User, userId: string, role: string) =>
      client.patch(`/api/v1/projects/${projectId}/members/${userId}`).json({ role }).loginAs(as)

    const response = await patch(owner, editor.id, 'viewer')
    response.assertStatus(200)
    assert.equal(memberResponseSchema.parse(response.body()).member.role, 'viewer')
    assert.equal(await roleOf(projectId, editor.id), 'viewer')
    assert.deepEqual(realtime.changes, [`${projectId}:${editor.id}`])

    // Même rôle : rien à notifier.
    ;(await patch(owner, editor.id, 'viewer')).assertStatus(200)
    assert.lengthOf(realtime.changes, 1)

    ;(await patch(editor, owner.id, 'viewer')).assertStatus(403)
    const locked = await patch(owner, owner.id, 'editor')
    locked.assertStatus(409)
    locked.assertBodyContains({ code: 'E_OWNER_ROLE_LOCKED' })
    ;(await patch(owner, randomUUID(), 'editor')).assertStatus(404)
    ;(await patch(owner, editor.id, 'owner')).assertStatus(422)
  })

  test('removes a member (owner) or leaves the project (member)', async ({ client, assert }) => {
    const owner = await createUser()
    await subscribePro(owner)
    const projectId = await newProject(client, owner)
    const editor = await addMember(projectId, 'editor')
    const viewer = await addMember(projectId, 'viewer')
    const remove = (as: User, userId: string) =>
      client.delete(`/api/v1/projects/${projectId}/members/${userId}`).loginAs(as)

    ;(await remove(editor, viewer.id)).assertStatus(403)
    ;(await remove(owner, viewer.id)).assertStatus(204)
    assert.isNull(await roleOf(projectId, viewer.id))
    assert.deepEqual(realtime.changes, [`${projectId}:${viewer.id}`])
    ;(await remove(owner, viewer.id)).assertStatus(404)

    ;(await remove(editor, editor.id)).assertStatus(204)
    assert.isNull(await roleOf(projectId, editor.id))
    assert.include(realtime.changes, `${projectId}:${editor.id}`)
    ;(await remove(editor, editor.id)).assertStatus(404)

    const leave = await remove(owner, owner.id)
    leave.assertStatus(409)
    leave.assertBodyContains({ code: 'E_OWNER_CANNOT_LEAVE' })
  })

  test('the owner transfers the ownership to an existing member', async ({ client, assert }) => {
    const owner = await createUser()
    const projectId = await newProject(client, owner)
    const viewer = await addMember(projectId, 'viewer')
    const transfer = (as: User, userId: string) =>
      client.post(`/api/v1/projects/${projectId}/transfer`).json({ userId }).loginAs(as)

    ;(await transfer(viewer, viewer.id)).assertStatus(403)
    ;(await transfer(owner, (await createUser()).id)).assertStatus(422)
    ;(await transfer(owner, owner.id)).assertStatus(409)

    const response = await transfer(owner, viewer.id)
    response.assertStatus(200)
    const members = projectMembersResponseSchema.parse(response.body())
    assert.deepEqual(
      members.members.map((member) => [member.user.id, member.role]),
      [
        [viewer.id, 'owner'],
        [owner.id, 'editor'],
      ],
    )
    // L'ancien propriétaire, devenu éditeur, ne voit plus les invitations.
    assert.isNull(members.collaborators)
    const project = await Project.findOrFail(projectId)
    const workspace = await Workspace.findOrFail(project.workspaceId)
    assert.equal(project.ownerId, viewer.id)
    assert.equal(workspace.ownerId, viewer.id)
    assert.equal(workspace.type, 'personal')
    assert.sameMembers(realtime.changes, [`${projectId}:${owner.id}`, `${projectId}:${viewer.id}`])
    ;(await transfer(owner, owner.id)).assertStatus(403)
  })

  test('applies the role matrix to the other project routes', async ({ client }) => {
    const owner = await createUser()
    await subscribePro(owner)
    const projectId = await newProject(client, owner)
    const editor = await addMember(projectId, 'editor')
    const reviewer = await addMember(projectId, 'reviewer')
    const viewer = await addMember(projectId, 'viewer')

    for (const reader of [viewer, reviewer]) {
      ;(await client.get(`/api/v1/projects/${projectId}/tree`).loginAs(reader)).assertStatus(200)
      ;(
        await client
          .post(`/api/v1/projects/${projectId}/documents`)
          .json({ name: `${randomUUID()}.tex` })
          .loginAs(reader)
      ).assertStatus(403)
      ;(
        await client.post(`/api/v1/projects/${projectId}/realtime-token`).loginAs(reader)
      ).assertStatus(200)
    }
    ;(
      await client
        .post(`/api/v1/projects/${projectId}/documents`)
        .json({ name: 'chapitre.tex' })
        .loginAs(editor)
    ).assertStatus(201)
    ;(
      await client
        .patch(`/api/v1/projects/${projectId}`)
        .json({ compiler: 'xelatex' })
        .loginAs(editor)
    ).assertStatus(200)
    ;(
      await client.patch(`/api/v1/projects/${projectId}`).json({ name: 'Autre' }).loginAs(editor)
    ).assertStatus(403)
    ;(await client.post(`/api/v1/projects/${projectId}/archive`).loginAs(editor)).assertStatus(403)
    ;(await client.get(`/api/v1/projects/${projectId}/share-links`).loginAs(editor)).assertStatus(
      403,
    )
  })
})

test.group('sharing: share links', (group) => {
  useSharingFakes(group)

  function tokenOf(url: string | null): string {
    const token = url?.split('/share/')[1]
    if (!token) throw new Error('no share link url')
    return token
  }

  test('enables, disables and regenerates the view and edit links', async ({ client, assert }) => {
    const owner = await createUser()
    const projectId = await newProject(client, owner, 'Partagé')
    const base = `/api/v1/projects/${projectId}/share-links`

    const initial = shareLinksResponseSchema.parse((await client.get(base).loginAs(owner)).body())
    assert.deepEqual(initial.links, [
      { kind: 'view', role: 'viewer', enabled: false, url: null, createdAt: null },
      { kind: 'edit', role: 'editor', enabled: false, url: null, createdAt: null },
    ])

    const enabled = shareLinkResponseSchema.parse(
      (await client.put(`${base}/view`).json({ enabled: true }).loginAs(owner)).body(),
    ).link
    assert.isTrue(enabled.enabled)
    assert.match(enabled.url ?? '', /^http:\/\/localhost:3000\/share\/[A-Za-z0-9_-]{43}$/)
    const token = tokenOf(enabled.url)
    assert.deepEqual(
      shareLinkPreviewSchema.parse((await client.get(`/api/v1/share/${token}`)).body()),
      { projectName: 'Partagé', role: 'viewer' },
    )
    // Lien réaffiché à l'identique ; seul son hash est stocké.
    const listed = shareLinksResponseSchema.parse((await client.get(base).loginAs(owner)).body())
    assert.equal(listed.links[0]?.url, enabled.url)

    ;(await client.put(`${base}/view`).json({ enabled: false }).loginAs(owner)).assertStatus(200)
    ;(await client.get(`/api/v1/share/${token}`)).assertStatus(404)
    const again = shareLinkResponseSchema.parse(
      (await client.put(`${base}/view`).json({ enabled: true }).loginAs(owner)).body(),
    ).link
    assert.equal(again.url, enabled.url)

    const regenerated = shareLinkResponseSchema.parse(
      (await client.post(`${base}/view/regenerate`).loginAs(owner)).body(),
    ).link
    assert.notEqual(regenerated.url, enabled.url)
    ;(await client.get(`/api/v1/share/${token}`)).assertStatus(404)
    ;(await client.get(`/api/v1/share/${tokenOf(regenerated.url)}`)).assertStatus(200)

    ;(
      await client
        .post(`/api/v1/share/${tokenOf(regenerated.url)}/join`)
        .loginAs(await createUser())
    ).assertStatus(200)
    assert.deepEqual(await sharingEvents(projectId), [
      'share_link.enabled',
      'share_link.disabled',
      'share_link.enabled',
      'share_link.regenerated',
      'share_link.joined',
    ])
    const rows = await db.from('project_sharing_events').where('project_id', projectId)
    assert.notInclude(JSON.stringify(rows), token)
    ;(await client.put(`${base}/other`).json({ enabled: true }).loginAs(owner)).assertStatus(404)
    ;(await client.put(`${base}/edit`).json({ enabled: 'yes' }).loginAs(owner)).assertStatus(422)
  })

  test('joins with the role of the link; a member keeps the higher role', async ({
    client,
    assert,
  }) => {
    const owner = await createUser()
    await subscribePro(owner)
    const projectId = await newProject(client, owner)
    const base = `/api/v1/projects/${projectId}/share-links`
    const view = tokenOf(
      shareLinkResponseSchema.parse(
        (await client.put(`${base}/view`).json({ enabled: true }).loginAs(owner)).body(),
      ).link.url,
    )
    const edit = tokenOf(
      shareLinkResponseSchema.parse(
        (await client.put(`${base}/edit`).json({ enabled: true }).loginAs(owner)).body(),
      ).link.url,
    )
    const join = (token: string, as: User) => client.post(`/api/v1/share/${token}/join`).loginAs(as)

    const reader = await createUser()
    assert.deepEqual(joinProjectResponseSchema.parse((await join(view, reader)).body()), {
      projectId,
      role: 'viewer',
      joined: true,
    })
    assert.deepEqual(realtime.changes, [])

    // Le lien d'édition relève le lecteur ; ses connexions ouvertes sont mises à jour.
    assert.deepEqual(joinProjectResponseSchema.parse((await join(edit, reader)).body()), {
      projectId,
      role: 'editor',
      joined: true,
    })
    assert.deepEqual(realtime.changes, [`${projectId}:${reader.id}`])
    assert.deepEqual(joinProjectResponseSchema.parse((await join(view, reader)).body()), {
      projectId,
      role: 'editor',
      joined: false,
    })
    assert.deepEqual(joinProjectResponseSchema.parse((await join(view, owner)).body()), {
      projectId,
      role: 'owner',
      joined: false,
    })
    ;(await client.post(`/api/v1/share/${view}/join`)).assertStatus(401)

    await client.post(`${base}/edit/regenerate`).loginAs(owner)
    const stale = await join(edit, await createUser())
    stale.assertStatus(404)
    stale.assertBodyContains({ code: 'E_SHARE_LINK_NOT_FOUND' })
  })

  test('joining by a link is subject to the collaborator limit', async ({ client, assert }) => {
    const owner = await createUser()
    const projectId = await newProject(client, owner)
    const link = shareLinkResponseSchema.parse(
      (
        await client
          .put(`/api/v1/projects/${projectId}/share-links/view`)
          .json({ enabled: true })
          .loginAs(owner)
      ).body(),
    ).link
    const token = tokenOf(link.url)
    ;(await client.post(`/api/v1/share/${token}/join`).loginAs(await createUser())).assertStatus(
      200,
    )
    const refused = await client.post(`/api/v1/share/${token}/join`).loginAs(await createUser())
    refused.assertStatus(403)
    assert.equal(planLimitErrorSchema.parse(refused.body()).limit.max, 1)
  })

  test('joining by a link settles the pending invitation of the same person', async ({
    client,
    assert,
  }) => {
    // Plan Free (1 collaborateur) : la place réservée par l'invitation sert à la personne invitée.
    const owner = await createUser()
    const projectId = await newProject(client, owner)
    const bob = await createUser()
    ;(await invite(client, owner, projectId, bob.email.toUpperCase(), 'editor')).assertStatus(201)
    const link = shareLinkResponseSchema.parse(
      (
        await client
          .put(`/api/v1/projects/${projectId}/share-links/view`)
          .json({ enabled: true })
          .loginAs(owner)
      ).body(),
    ).link
    const joined = await client.post(`/api/v1/share/${tokenOf(link.url)}/join`).loginAs(bob)
    joined.assertStatus(200)
    // L'invitation valide est acceptée : son rôle (plus élevé que celui du lien) compte.
    assert.equal(joinProjectResponseSchema.parse(joined.body()).role, 'editor')
    assert.equal(await roleOf(projectId, bob.id), 'editor')

    const members = projectMembersResponseSchema.parse(
      (await client.get(`/api/v1/projects/${projectId}/members`).loginAs(owner)).body(),
    )
    assert.deepEqual(members.invitations, [])
    assert.equal(members.collaborators?.used, 1)
    const invitation = await ProjectInvitation.query().where({ projectId }).firstOrFail()
    assert.isNotNull(invitation.acceptedAt)
    assert.includeMembers(await sharingEvents(projectId), [
      'invitation.accepted',
      'share_link.joined',
    ])
  })

  test('joining by a link cancels an expired invitation of the same person', async ({
    client,
    assert,
  }) => {
    const owner = await createUser()
    const projectId = await newProject(client, owner)
    const bob = await createUser()
    ;(await invite(client, owner, projectId, bob.email, 'editor')).assertStatus(201)
    await ProjectInvitation.query()
      .where({ projectId })
      .update({ expiresAt: DateTime.utc().minus({ days: 1 }).toJSDate() })
    const link = shareLinkResponseSchema.parse(
      (
        await client
          .put(`/api/v1/projects/${projectId}/share-links/view`)
          .json({ enabled: true })
          .loginAs(owner)
      ).body(),
    ).link
    const joined = await client.post(`/api/v1/share/${tokenOf(link.url)}/join`).loginAs(bob)
    joined.assertStatus(200)
    assert.equal(await roleOf(projectId, bob.id), 'viewer')
    const invitation = await ProjectInvitation.query().where({ projectId }).firstOrFail()
    assert.isNull(invitation.acceptedAt)
    assert.isNotNull(invitation.cancelledAt)
  })
})
