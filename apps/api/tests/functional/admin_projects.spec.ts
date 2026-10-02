import { randomUUID } from 'node:crypto'
import {
  activeBannersResponseSchema,
  adminAuditLogResponseSchema,
  adminBannerResponseSchema,
  adminBannersResponseSchema,
  adminProjectResponseSchema,
  adminProjectsResponseSchema,
  adminStatsSchema,
} from '@kaxolax/contracts'
import { test } from '@japa/runner'
import type { ApiClient } from '@japa/api-client'
import { DateTime } from 'luxon'
import AdminAuditLog from '#models/admin_audit_log'
import Compile from '#models/compile'
import Project from '#models/project'
import ProjectMember from '#models/project_member'
import Subscription from '#models/subscription'
import type User from '#models/user'
import Workspace from '#models/workspace'
import { adminFakes, createAdmin, useAdminFakes } from '#tests/admin'
import { createUser } from '#tests/helpers'

async function newProject(client: ApiClient, owner: User, name = 'Thèse'): Promise<string> {
  const response = await client.post('/api/v1/projects').json({ name }).loginAs(owner)
  response.assertStatus(201)
  return response.body().project.id as string
}

test.group('admin: projects', (group) => {
  useAdminFakes(group)

  test('searches projects by name, owner email, owner name and id', async ({ client, assert }) => {
    const { token } = await createAdmin(adminFakes.clerk)
    const owner = await createUser({ email: `owner-${randomUUID()}@lab.example` })
    owner.fullName = 'Grace Hopper'
    await owner.save()
    const paper = await newProject(client, owner, 'Quantum paper')
    const notesOwner = await createUser()
    const notes = await newProject(client, notesOwner, 'Notes')
    await client.post(`/api/v1/projects/${notes}/trash`).loginAs(notesOwner)

    const ids = async (query: string) =>
      adminProjectsResponseSchema
        .parse((await client.get(`/api/v1/admin/projects${query}`).bearerToken(token)).body())
        .projects.map((project) => project.id)
    assert.deepEqual(await ids('?q=QUANTUM'), [paper])
    assert.deepEqual(await ids('?q=lab.example'), [paper])
    assert.deepEqual(await ids('?q=hopper'), [paper])
    assert.deepEqual(await ids(`?q=${paper}`), [paper])
    assert.deepEqual(await ids(`?q=${owner.id}`), [paper])
    assert.sameMembers(await ids(''), [paper, notes])
    assert.deepEqual(await ids('?view=trashed'), [notes])
    assert.deepEqual(await ids('?view=active'), [paper])
  })

  test('shows metadata without any file name or content', async ({ client, assert }) => {
    const { token } = await createAdmin(adminFakes.clerk)
    const owner = await createUser()
    const editor = await createUser()
    const projectId = await newProject(client, owner)
    await ProjectMember.create({ projectId, userId: editor.id, role: 'editor' })
    await Compile.create({
      id: randomUUID(),
      projectId,
      userId: owner.id,
      compiler: 'pdflatex',
      status: 'success',
      durationMs: 1200,
      agentId: 'agent-1',
      outputPrefix: `outputs/${projectId}/x/`,
    })

    const response = await client.get(`/api/v1/admin/projects/${projectId}`).bearerToken(token)
    response.assertStatus(200)
    const { project } = adminProjectResponseSchema.parse(response.body())
    assert.equal(project.documentCount, 1)
    assert.equal(project.fileCount, 0)
    assert.equal(project.memberCount, 2)
    assert.isAbove(project.sizeBytes, 0)
    assert.deepEqual(
      project.members.map((member) => member.role),
      ['owner', 'editor'],
    )
    assert.equal(project.lastCompile?.agentId, 'agent-1')
    assert.equal(project.workspace.ownerId, owner.id)
    const text = JSON.stringify(response.body())
    assert.notInclude(text, 'main.tex')
    assert.notInclude(text, 'documentclass')
  })

  test('transfers ownership to another account and its workspace', async ({ client, assert }) => {
    const { admin, token } = await createAdmin(adminFakes.clerk)
    const owner = await createUser()
    const next = await createUser()
    const projectId = await newProject(client, owner)

    const response = await client
      .post(`/api/v1/admin/projects/${projectId}/transfer`)
      .json({ newOwnerId: next.id })
      .bearerToken(token)
    response.assertStatus(200)
    const project = await Project.findOrFail(projectId)
    assert.equal(project.ownerId, next.id)
    const workspace = await Workspace.findOrFail(project.workspaceId)
    assert.equal(workspace.ownerId, next.id)
    assert.equal(workspace.type, 'personal')
    const roles = await ProjectMember.query().where('project_id', projectId)
    assert.sameDeepMembers(
      roles.map((member) => ({ userId: member.userId, role: member.role })),
      [
        { userId: owner.id, role: 'editor' },
        { userId: next.id, role: 'owner' },
      ],
    )
    const entry = await AdminAuditLog.query().where('target_id', projectId).firstOrFail()
    assert.equal(entry.action, 'project.transfer')
    assert.equal(entry.adminId, admin.id)
    assert.deepInclude(entry.metadata, { fromUserId: owner.id, toUserId: next.id })
    // Les deux rôles ont changé : le service temps réel est notifié.
    assert.sameMembers(adminFakes.realtime.memberChanges, [
      `${projectId}:${owner.id}`,
      `${projectId}:${next.id}`,
    ])

    // L'ancien propriétaire, désormais éditeur, ne peut plus supprimer le projet.
    await client.post(`/api/v1/projects/${projectId}/trash`).loginAs(next)
    const forbidden = await client.delete(`/api/v1/projects/${projectId}`).loginAs(owner)
    forbidden.assertStatus(403)

    const again = await client
      .post(`/api/v1/admin/projects/${projectId}/transfer`)
      .json({ newOwnerId: next.id })
      .bearerToken(token)
    again.assertStatus(409)
    const unknown = await client
      .post(`/api/v1/admin/projects/${projectId}/transfer`)
      .json({ newOwnerId: randomUUID() })
      .bearerToken(token)
    unknown.assertStatus(422)

    // Un compte banni ne devient pas propriétaire : le projet n'aurait plus de propriétaire actif.
    const banned = await createUser()
    banned.bannedAt = DateTime.utc()
    await banned.save()
    const refused = await client
      .post(`/api/v1/admin/projects/${projectId}/transfer`)
      .json({ newOwnerId: banned.id })
      .bearerToken(token)
    refused.assertStatus(422)
    assert.equal(refused.body().code, 'E_INVALID_NEW_OWNER')
    assert.equal((await Project.findOrFail(projectId)).ownerId, next.id)
  })

  test('archives, trashes, restores and deletes with a journal entry each', async ({
    client,
    assert,
  }) => {
    const { token } = await createAdmin(adminFakes.clerk)
    const owner = await createUser()
    const projectId = await newProject(client, owner)
    const post = (action: string) =>
      client.post(`/api/v1/admin/projects/${projectId}/${action}`).bearerToken(token)

    ;(await post('archive')).assertStatus(200)
    ;(await post('archive')).assertStatus(200) // déjà archivé : aucun changement
    ;(await post('unarchive')).assertStatus(200)
    ;(await client.delete(`/api/v1/admin/projects/${projectId}`).bearerToken(token)).assertStatus(
      409,
    )
    const trashed = await post('trash')
    assert.isNotNull(adminProjectResponseSchema.parse(trashed.body()).project.trashedAt)
    ;(await post('restore')).assertStatus(200)
    ;(await post('trash')).assertStatus(200)
    const project = await Project.findOrFail(projectId)
    ;(await client.delete(`/api/v1/admin/projects/${projectId}`).bearerToken(token)).assertStatus(
      204,
    )
    assert.isNull(await Project.find(projectId))
    assert.include(adminFakes.realtime.closed, project.mainDocumentId ?? '')

    const log = adminAuditLogResponseSchema.parse(
      (
        await client
          .get(`/api/v1/admin/audit-log?targetType=project&targetId=${projectId}&perPage=100`)
          .bearerToken(token)
      ).body(),
    )
    assert.deepEqual(log.entries.map((entry) => entry.action).toReversed(), [
      'project.archive',
      'project.unarchive',
      'project.trash',
      'project.restore',
      'project.trash',
      'project.delete',
    ])
    ;(await post('archive')).assertStatus(404)
  })
})

test.group('admin: banners', (group) => {
  useAdminFakes(group)

  test('shows only the banners active right now', async ({ client, assert }) => {
    const { token } = await createAdmin(adminFakes.clerk)
    const user = await createUser()
    const create = async (body: Record<string, unknown>) => {
      const response = await client.post('/api/v1/admin/banners').json(body).bearerToken(token)
      response.assertStatus(201)
      return adminBannerResponseSchema.parse(response.body()).banner
    }
    const now = DateTime.utc()
    const current = await create({ message: 'Nouvelle version', level: 'info' })
    const maintenance = await create({
      message: 'Maintenance ce soir',
      level: 'maintenance',
      startsAt: now.minus({ hours: 1 }).toISO(),
      endsAt: now.plus({ hours: 1 }).toISO(),
    })
    const scheduled = await create({
      message: 'Plus tard',
      level: 'warning',
      startsAt: now.plus({ days: 1 }).toISO(),
    })
    const ended = await create({
      message: 'Terminée',
      level: 'warning',
      startsAt: now.minus({ days: 2 }).toISO(),
      endsAt: now.minus({ days: 1 }).toISO(),
    })
    assert.equal(scheduled.status, 'scheduled')
    assert.equal(ended.status, 'ended')
    assert.equal(current.status, 'active')
    assert.lengthOf(adminFakes.realtime.bannerNotifications, 4)

    const active = async () =>
      activeBannersResponseSchema
        .parse((await client.get('/api/v1/banners/active').loginAs(user)).body())
        .banners.map((banner) => banner.id)
    // La maintenance passe en premier.
    assert.deepEqual(await active(), [maintenance.id, current.id])

    // Fin programmée et texte modifié ; la maintenance est supprimée.
    const updated = await client
      .patch(`/api/v1/admin/banners/${current.id}`)
      .json({ endsAt: DateTime.utc().plus({ hours: 2 }).toISO(), message: 'Modifiée' })
      .bearerToken(token)
    updated.assertStatus(200)
    assert.equal(adminBannerResponseSchema.parse(updated.body()).banner.message, 'Modifiée')
    ;(
      await client.delete(`/api/v1/admin/banners/${maintenance.id}`).bearerToken(token)
    ).assertStatus(204)
    assert.deepEqual(await active(), [current.id])

    const list = adminBannersResponseSchema.parse(
      (await client.get('/api/v1/admin/banners').bearerToken(token)).body(),
    )
    assert.lengthOf(list.banners, 3)
    const actions = await AdminAuditLog.query().where('target_type', 'banner')
    assert.sameMembers(
      actions.map((entry) => entry.action),
      [
        'banner.create',
        'banner.create',
        'banner.create',
        'banner.create',
        'banner.update',
        'banner.delete',
      ],
    )
  })

  test('refuses a banner that ends before it starts', async ({ client, assert }) => {
    const { token } = await createAdmin(adminFakes.clerk)
    const now = DateTime.utc()
    const backwards = await client
      .post('/api/v1/admin/banners')
      .json({
        message: 'Erreur',
        level: 'info',
        startsAt: now.toISO(),
        endsAt: now.minus({ minutes: 1 }).toISO(),
      })
      .bearerToken(token)
    backwards.assertStatus(422)
    const created = await client
      .post('/api/v1/admin/banners')
      .json({ message: 'Ok', level: 'info', startsAt: now.toISO() })
      .bearerToken(token)
    const banner = adminBannerResponseSchema.parse(created.body()).banner
    // Seule la fin change : comparée au début enregistré.
    const patched = await client
      .patch(`/api/v1/admin/banners/${banner.id}`)
      .json({ endsAt: now.minus({ hours: 1 }).toISO() })
      .bearerToken(token)
    patched.assertStatus(422)
    assert.equal(patched.body().code, 'E_INVALID_BANNER_PERIOD')
    const noZone = await client
      .post('/api/v1/admin/banners')
      .json({ message: 'Ok', level: 'info', startsAt: '2026-10-01T10:00:00' })
      .bearerToken(token)
    noZone.assertStatus(422)
    ;(
      await client.patch(`/api/v1/admin/banners/${randomUUID()}`).json({}).bearerToken(token)
    ).assertStatus(404)
  })

  test('ends a banner at the server time', async ({ client, assert }) => {
    const { token } = await createAdmin(adminFakes.clerk)
    const user = await createUser()
    // Commencée il y a une seconde : une horloge d'admin en retard aurait donné une fin avant le début.
    const created = await client
      .post('/api/v1/admin/banners')
      .json({
        message: 'Incident',
        level: 'warning',
        startsAt: DateTime.utc().minus({ seconds: 1 }).toISO(),
      })
      .bearerToken(token)
    created.assertStatus(201)
    const banner = adminBannerResponseSchema.parse(created.body()).banner

    const ended = await client.post(`/api/v1/admin/banners/${banner.id}/end`).bearerToken(token)
    ended.assertStatus(200)
    const after = adminBannerResponseSchema.parse(ended.body()).banner
    assert.equal(after.status, 'ended')
    assert.isAtMost(new Date(after.endsAt ?? '').getTime(), Date.now())
    const active = activeBannersResponseSchema.parse(
      (await client.get('/api/v1/banners/active').loginAs(user)).body(),
    )
    assert.notInclude(
      active.banners.map((item) => item.id),
      banner.id,
    )
    const entry = await AdminAuditLog.query()
      .where({ targetId: banner.id, action: 'banner.update' })
      .firstOrFail()
    assert.deepInclude(entry.metadata, { outcome: 'success' })

    // Déjà terminée : la fin enregistrée ne bouge pas.
    const again = await client.post(`/api/v1/admin/banners/${banner.id}/end`).bearerToken(token)
    again.assertStatus(200)
    assert.equal(adminBannerResponseSchema.parse(again.body()).banner.endsAt, after.endsAt)
    ;(
      await client.post(`/api/v1/admin/banners/${randomUUID()}/end`).bearerToken(token)
    ).assertStatus(404)
  })
})

test.group('admin: statistics', (group) => {
  useAdminFakes(group)

  test('computes signups, active users, subscribers and compiles', async ({ client, assert }) => {
    const { token } = await createAdmin(adminFakes.clerk)
    const day = (iso: string) => DateTime.fromISO(iso, { zone: 'utc' })
    const alice = await createUser()
    const bob = await createUser()
    const carol = await createUser()
    alice.createdAt = day('2026-03-02T10:00:00')
    bob.createdAt = day('2026-03-02T23:30:00')
    carol.createdAt = day('2026-03-04T08:00:00')
    for (const user of [alice, bob, carol]) await user.save()

    const projectId = await newProject(client, alice)
    // Le projet n'a pas été modifié pendant la période : seules les compilations comptent.
    await Project.query()
      .where('id', projectId)
      .update({ updated_at: day('2026-01-01').toJSDate() })
    const compile = (
      userId: string,
      at: string,
      status: string,
      agentId: string | null,
      ms: number,
    ) =>
      Compile.create({
        id: randomUUID(),
        projectId,
        userId,
        compiler: 'pdflatex',
        status: status as 'success',
        durationMs: ms,
        agentId,
        outputPrefix: 'outputs/x/',
        createdAt: day(at),
      })
    await compile(alice.id, '2026-03-28T10:00:00', 'success', 'agent-a', 1000)
    await compile(alice.id, '2026-03-29T10:00:00', 'failure', 'agent-a', 3000)
    await compile(bob.id, '2026-03-10T10:00:00', 'timeout', 'agent-b', 20000)
    await compile(bob.id, '2026-03-11T10:00:00', 'error', null, 0)
    // Hors période.
    await compile(carol.id, '2026-04-02T10:00:00', 'success', 'agent-a', 500)

    await Subscription.createMany([
      {
        userId: alice.id,
        clerkSubscriptionItemId: `csi_${randomUUID()}`,
        planSlug: 'pro',
        status: 'active',
      },
      {
        userId: bob.id,
        clerkSubscriptionItemId: `csi_${randomUUID()}`,
        planSlug: 'pro',
        status: 'past_due',
      },
      {
        userId: carol.id,
        clerkSubscriptionItemId: `csi_${randomUUID()}`,
        planSlug: 'pro',
        status: 'canceled',
      },
    ])

    const response = await client
      .get('/api/v1/admin/stats?from=2026-03-01T00:00:00Z&to=2026-04-01T00:00:00Z')
      .bearerToken(token)
    response.assertStatus(200)
    const stats = adminStatsSchema.parse(response.body())
    assert.equal(stats.signups.total, 3)
    assert.lengthOf(stats.signups.byDay, 31)
    assert.deepEqual(stats.signups.byDay[1], { date: '2026-03-02', count: 2 })
    assert.deepEqual(stats.signups.byDay[3], { date: '2026-03-04', count: 1 })
    // 7 jours : alice (compilations du 28 et 29) ; 30 jours : alice et bob.
    assert.deepEqual(stats.activeUsers, { last7Days: 1, last30Days: 2 })
    assert.equal(stats.subscriptions.pro, 1)
    assert.deepEqual(stats.subscriptions.byPlan, [{ planSlug: 'pro', active: 1, pastDue: 1 }])
    assert.equal(stats.compiles.total, 4)
    assert.deepEqual(stats.compiles.byStatus, { success: 1, failure: 1, timeout: 1, error: 1 })
    assert.equal(stats.compiles.averageDurationMs, 6000)
    assert.equal(stats.compiles.failureRate, 0.75)
    assert.deepEqual(stats.compiles.byAgent, [
      { agentId: 'agent-a', total: 2, averageDurationMs: 2000, failureRate: 0.5 },
      { agentId: 'agent-b', total: 1, averageDurationMs: 20000, failureRate: 1 },
      { agentId: null, total: 1, averageDurationMs: 0, failureRate: 1 },
    ])

    const invalid = await client
      .get('/api/v1/admin/stats?from=2026-04-01T00:00:00Z&to=2026-03-01T00:00:00Z')
      .bearerToken(token)
    invalid.assertStatus(422)
  })
})
