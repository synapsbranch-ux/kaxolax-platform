import { randomUUID } from 'node:crypto'
import {
  ADMIN_MFA_REQUIRED_ERROR,
  ADMIN_REQUIRED_ERROR,
  adminAuditLogResponseSchema,
  adminRevokeSessionsResponseSchema,
  adminUserActionResponseSchema,
  adminUserResponseSchema,
  adminUsersResponseSchema,
} from '@kaxolax/contracts'
import { test } from '@japa/runner'
import type { ApiClient } from '@japa/api-client'
import { DateTime } from 'luxon'
import AdminAuditLog from '#models/admin_audit_log'
import File from '#models/file'
import Project from '#models/project'
import ProjectMember from '#models/project_member'
import Subscription from '#models/subscription'
import User from '#models/user'
import { forgetAdminStatus } from '#services/admin_access'
import { adminFakes, adminTokenFor, createAdmin, useAdminFakes } from '#tests/admin'
import { clerkTokenFor } from '#tests/clerk'
import { signWebhook } from '#tests/clerk_keys'
import { createUser } from '#tests/helpers'

async function newProject(client: ApiClient, owner: User, name = 'Thèse'): Promise<string> {
  const response = await client.post('/api/v1/projects').json({ name }).loginAs(owner)
  response.assertStatus(201)
  return response.body().project.id as string
}

/** Entrées du journal pour une cible, les plus anciennes d'abord. */
async function auditOf(targetId: string) {
  return AdminAuditLog.query().where('target_id', targetId).orderBy('created_at')
}

test.group('admin: access', (group) => {
  useAdminFakes(group)

  test('refuses anonymous requests and accounts without the admin role', async ({
    client,
    assert,
  }) => {
    ;(await client.get('/api/v1/admin/users')).assertStatus(401)

    const user = await createUser()
    const plain = await client.get('/api/v1/admin/users').loginAs(user)
    plain.assertStatus(403)
    assert.equal(plain.body().code, ADMIN_REQUIRED_ERROR)
    const otherRole = await client
      .get('/api/v1/admin/stats')
      .bearerToken(clerkTokenFor(user, { metadata: { role: 'support' }, fva: [1, 1] }))
    otherRole.assertStatus(403)
    assert.equal(otherRole.body().code, ADMIN_REQUIRED_ERROR)
    // Le claim suffit à refuser : Clerk n'est pas appelé.
    assert.deepEqual(adminFakes.clerk.calls, [])
  })

  test('requires a second factor verified in the session and enabled in Clerk', async ({
    client,
    assert,
  }) => {
    const { admin, token } = await createAdmin(adminFakes.clerk)
    for (const fva of [[2, -1], undefined, 'bad']) {
      const response = await client
        .get('/api/v1/admin/users')
        .bearerToken(adminTokenFor(admin, { fva }))
      response.assertStatus(403)
      assert.equal(response.body().code, ADMIN_MFA_REQUIRED_ERROR)
    }

    adminFakes.clerk.account(admin, { role: 'admin', twoFactorEnabled: false })
    const disabled = await client.get('/api/v1/admin/users').bearerToken(token)
    disabled.assertStatus(403)
    assert.equal(disabled.body().code, ADMIN_MFA_REQUIRED_ERROR)

    // Rôle retiré dans Clerk alors que le jeton le porte encore.
    forgetAdminStatus()
    adminFakes.clerk.account(admin, { role: null, twoFactorEnabled: true })
    const demoted = await client.get('/api/v1/admin/users').bearerToken(token)
    demoted.assertStatus(403)
    assert.equal(demoted.body().code, ADMIN_REQUIRED_ERROR)
  })

  test('lets an admin with MFA in and caches the Clerk check', async ({ client, assert }) => {
    const { admin, token } = await createAdmin(adminFakes.clerk)
    ;(await client.get('/api/v1/admin/users').bearerToken(token)).assertStatus(200)
    ;(await client.get('/api/v1/admin/stats').bearerToken(token)).assertStatus(200)
    assert.deepEqual(adminFakes.clerk.calls, [`getUser:${admin.clerkUserId}`])
  })

  test('serves active banners to any signed-in user, not the admin routes', async ({ client }) => {
    const user = await createUser()
    ;(await client.get('/api/v1/banners/active').loginAs(user)).assertStatus(200)
    ;(await client.get('/api/v1/banners/active')).assertStatus(401)
    ;(await client.get('/api/v1/admin/banners').loginAs(user)).assertStatus(403)
  })
})

test.group('admin: users', (group) => {
  useAdminFakes(group)

  test('searches users by email, name and id, with pagination', async ({ client, assert }) => {
    const { token } = await createAdmin(adminFakes.clerk)
    const grace = await createUser({ email: `grace-${randomUUID()}@navy.example` })
    grace.fullName = 'Grace Hopper'
    await grace.save()
    await createUser()

    const search = async (query: string) =>
      adminUsersResponseSchema.parse(
        (await client.get(`/api/v1/admin/users${query}`).bearerToken(token)).body(),
      )
    assert.deepEqual(
      (await search('?q=NAVY.example')).users.map((user) => user.id),
      [grace.id],
    )
    assert.deepEqual(
      (await search('?q=hopper')).users.map((user) => user.id),
      [grace.id],
    )
    assert.deepEqual(
      (await search(`?q=${grace.id}`)).users.map((user) => user.id),
      [grace.id],
    )
    assert.deepEqual(
      (await search(`?q=${grace.clerkUserId}`)).users.map((user) => user.id),
      [grace.id],
    )
    assert.deepEqual((await search('?q=%25')).users, [])
    const page = await search('?perPage=1&page=2')
    assert.lengthOf(page.users, 1)
    assert.deepInclude(page.pagination, { page: 2, perPage: 1, total: 3, lastPage: 3 })
    ;(await client.get('/api/v1/admin/users?perPage=500').bearerToken(token)).assertStatus(422)
  })

  test('shows the plan, usage and last sign-in of a user', async ({ client, assert }) => {
    const { token } = await createAdmin(adminFakes.clerk)
    const user = await createUser()
    const other = await createUser()
    const owned = await newProject(client, user)
    const shared = await newProject(client, other)
    await ProjectMember.create({ projectId: shared, userId: user.id, role: 'editor' })
    for (const size of [1_000, 2_500]) {
      await File.create({
        projectId: owned,
        folderId: null,
        name: `${randomUUID()}.png`,
        s3Key: `projects/${owned}/files/${randomUUID()}`,
        sha256: randomUUID(),
        sizeBytes: size,
        mimeType: 'image/png',
      })
    }
    await Subscription.create({
      userId: user.id,
      clerkSubscriptionItemId: `csi_${randomUUID()}`,
      planSlug: 'pro',
      status: 'active',
      periodEnd: DateTime.utc().plus({ days: 20 }),
    })
    const lastSignInAt = DateTime.utc().minus({ hours: 3 }).startOf('second')
    adminFakes.clerk.account(user, { lastSignInAt, twoFactorEnabled: true })

    const response = await client.get(`/api/v1/admin/users/${user.id}`).bearerToken(token)
    response.assertStatus(200)
    const { user: detail } = adminUserResponseSchema.parse(response.body())
    assert.equal(detail.planSlug, 'pro')
    assert.equal(detail.plan.status, 'active')
    assert.equal(detail.plan.limits?.maxCompileSeconds, 240)
    assert.equal(detail.ownedProjects, 1)
    assert.equal(detail.memberProjects, 1)
    assert.equal(detail.storageBytes, 3_500)
    assert.equal(detail.clerk?.lastSignInAt, lastSignInAt.toISO())
    assert.isTrue(detail.clerk?.twoFactorEnabled)

    const free = await client.get(`/api/v1/admin/users/${other.id}`).bearerToken(token)
    const freeDetail = adminUserResponseSchema.parse(free.body()).user
    assert.equal(freeDetail.planSlug, 'free')
    assert.isNull(freeDetail.clerk)
    ;(await client.get(`/api/v1/admin/users/${randomUUID()}`).bearerToken(token)).assertStatus(404)
  })

  test('bans a user: Clerk, local flag, realtime disconnect, journal, 401', async ({
    client,
    assert,
  }) => {
    const { admin, token } = await createAdmin(adminFakes.clerk)
    const target = await createUser()
    adminFakes.clerk.account(target)
    ;(await client.get('/api/v1/me').loginAs(target)).assertStatus(200)

    const response = await client.post(`/api/v1/admin/users/${target.id}/ban`).bearerToken(token)
    response.assertStatus(200)
    assert.isTrue(adminUserActionResponseSchema.parse(response.body()).realtimeDisconnected)
    assert.include(adminFakes.clerk.calls, `banUser:${target.clerkUserId}`)
    await target.refresh()
    assert.isNotNull(target.bannedAt)
    assert.deepEqual(adminFakes.realtime.disconnected, [target.id])
    const [entry, disconnect] = await auditOf(target.id)
    assert.equal(entry?.action, 'user.ban')
    assert.equal(entry?.adminId, admin.id)
    assert.equal(entry?.metadata.outcome, 'success')
    assert.equal(disconnect?.action, 'user.realtime_disconnect')
    assert.equal(disconnect?.metadata.trigger, 'user.ban')
    assert.equal(disconnect?.metadata.connectionsClosed, 1)
    assert.equal(disconnect?.metadata.outcome, 'success')

    // Ses jetons encore valides sont refusés.
    const refused = await client.get('/api/v1/me').loginAs(target)
    refused.assertStatus(401)
    assert.equal(refused.body().code, 'E_ACCOUNT_BANNED')

    ;(await client.post(`/api/v1/admin/users/${target.id}/unban`).bearerToken(token)).assertStatus(
      200,
    )
    await target.refresh()
    assert.isNull(target.bannedAt)
    ;(await client.get('/api/v1/me').loginAs(target)).assertStatus(200)
    assert.deepEqual(
      (await auditOf(target.id)).map((log) => log.action),
      ['user.ban', 'user.realtime_disconnect', 'user.unban'],
    )
  })

  test('reports a realtime service that could not disconnect the user', async ({
    client,
    assert,
  }) => {
    const { token } = await createAdmin(adminFakes.clerk)
    const target = await createUser()
    adminFakes.clerk.account(target)
    adminFakes.realtime.unreachable = true

    // Le bannissement est fait (Clerk et base) ; l'échec de la déconnexion est signalé et journalisé.
    const response = await client.post(`/api/v1/admin/users/${target.id}/ban`).bearerToken(token)
    response.assertStatus(200)
    assert.isFalse(adminUserActionResponseSchema.parse(response.body()).realtimeDisconnected)
    await target.refresh()
    assert.isNotNull(target.bannedAt)
    const [entry, disconnect] = await auditOf(target.id)
    assert.equal(entry?.metadata.outcome, 'success')
    assert.equal(disconnect?.action, 'user.realtime_disconnect')
    assert.isNull(disconnect?.metadata.connectionsClosed)
    assert.equal(disconnect?.metadata.outcome, 'failure')

    const revoke = await client
      .post(`/api/v1/admin/users/${target.id}/revoke-sessions`)
      .bearerToken(token)
    revoke.assertStatus(200)
    assert.isFalse(adminRevokeSessionsResponseSchema.parse(revoke.body()).realtimeDisconnected)
  })

  test('records a failed Clerk call without changing the account', async ({ client, assert }) => {
    const { token } = await createAdmin(adminFakes.clerk)
    const target = await createUser()
    adminFakes.clerk.failing.add('banUser')

    const response = await client.post(`/api/v1/admin/users/${target.id}/ban`).bearerToken(token)
    response.assertStatus(502)
    await target.refresh()
    assert.isNull(target.bannedAt)
    assert.deepEqual(adminFakes.realtime.disconnected, [])
    const [entry] = await auditOf(target.id)
    assert.equal(entry?.action, 'user.ban')
    assert.equal(entry?.metadata.outcome, 'failure')
    assert.deepEqual(entry?.metadata.error, { code: 'E_CLERK_REQUEST_FAILED', status: 502 })

    const failures = adminAuditLogResponseSchema.parse(
      (await client.get('/api/v1/admin/audit-log?outcome=failure').bearerToken(token)).body(),
    )
    assert.deepEqual(
      failures.entries.map((log) => log.targetId),
      [target.id],
    )
  })

  test('refuses actions on the admin own account', async ({ client, assert }) => {
    const { admin, token } = await createAdmin(adminFakes.clerk)
    const response = await client.post(`/api/v1/admin/users/${admin.id}/ban`).bearerToken(token)
    response.assertStatus(409)
    assert.deepEqual(await auditOf(admin.id), [])
  })

  test('revokes every session and closes realtime connections', async ({ client, assert }) => {
    const { token } = await createAdmin(adminFakes.clerk)
    const target = await createUser()
    const response = await client
      .post(`/api/v1/admin/users/${target.id}/revoke-sessions`)
      .bearerToken(token)
    response.assertStatus(200)
    assert.deepEqual(adminRevokeSessionsResponseSchema.parse(response.body()), {
      revokedSessions: 2,
      realtimeDisconnected: true,
    })
    assert.deepEqual(adminFakes.realtime.disconnected, [target.id])
    const [entry] = await auditOf(target.id)
    assert.equal(entry?.action, 'user.revoke_sessions')
    assert.equal(entry?.metadata.revokedSessions, 2)

    // Jeton émis avant la révocation (encore valide chez Clerk) : refusé, y compris pour obtenir
    // un nouveau jeton temps réel. Celui d'une nouvelle session, émis ensuite, est accepté.
    await target.refresh()
    assert.isNotNull(target.sessionsRevokedAt)
    const issuedBefore = Math.floor(Date.now() / 1000) - 5
    const old = clerkTokenFor(target, { iat: issuedBefore, nbf: issuedBefore - 5 })
    ;(await client.get('/api/v1/projects').bearerToken(old)).assertStatus(401)
    const next = clerkTokenFor(target, { iat: Math.floor(Date.now() / 1000) + 1 })
    ;(await client.get('/api/v1/projects').bearerToken(next)).assertStatus(200)
  })

  test('deletes an account in Clerk and anonymizes it at once', async ({ client, assert }) => {
    const { token } = await createAdmin(adminFakes.clerk)
    const target = await createUser()
    const other = await createUser()
    adminFakes.clerk.account(target)
    const owned = await newProject(client, target)
    const shared = await newProject(client, other)
    await ProjectMember.create({ projectId: shared, userId: target.id, role: 'viewer' })
    const email = target.email

    const response = await client.delete(`/api/v1/admin/users/${target.id}`).bearerToken(token)
    response.assertStatus(200)
    assert.include(adminFakes.clerk.calls, `deleteUser:${target.clerkUserId}`)
    await target.refresh()
    assert.isNotNull(target.deletedAt)
    assert.notEqual(target.email, email)
    assert.isNull(await Project.find(owned))
    assert.isNull(await ProjectMember.query().where('user_id', target.id).first())
    const [entry] = await auditOf(target.id)
    assert.equal(entry?.action, 'user.delete')
    // Le journal ne garde que des identifiants : l'email anonymisé n'y reste pas en clair.
    assert.equal(entry?.metadata.clerkUserId, target.clerkUserId)
    assert.notProperty(entry?.metadata ?? {}, 'email')
    assert.equal(entry?.metadata.deletedProjects, 1)

    // Le webhook user.deleted qui suit n'a plus d'effet ; une seconde suppression est refusée.
    const body = JSON.stringify({ type: 'user.deleted', data: { id: target.clerkUserId } })
    const webhook = await client
      .post('/api/v1/webhooks/clerk')
      .headers({ ...signWebhook(body), 'content-type': 'application/json' })
      .json(JSON.parse(body) as object)
    webhook.assertStatus(204)
    ;(await client.delete(`/api/v1/admin/users/${target.id}`).bearerToken(token)).assertStatus(409)
  })
})

test.group('admin: ban state from Clerk webhooks', (group) => {
  useAdminFakes(group)

  async function sendUserUpdated(client: ApiClient, user: User, banned: boolean, at: number) {
    const body = JSON.stringify({
      type: 'user.updated',
      object: 'event',
      data: {
        id: user.clerkUserId,
        banned,
        updated_at: at,
        primary_email_address_id: 'idn_1',
        email_addresses: [
          { id: 'idn_1', email_address: user.email, verification: { status: 'verified' } },
        ],
      },
    })
    return client
      .post('/api/v1/webhooks/clerk')
      .headers({ ...signWebhook(body), 'content-type': 'application/json' })
      .json(JSON.parse(body) as object)
  }

  test('mirrors banned from user.updated and ignores an older event', async ({
    client,
    assert,
  }) => {
    const user = await createUser()
    const now = Date.now()
    ;(await sendUserUpdated(client, user, true, now)).assertStatus(204)
    await user.refresh()
    assert.isNotNull(user.bannedAt)
    assert.deepEqual(adminFakes.realtime.disconnected, [user.id])
    ;(await client.get('/api/v1/me').loginAs(user)).assertStatus(401)

    // Un événement plus ancien, arrivé en retard, ne lève pas le bannissement.
    ;(await sendUserUpdated(client, user, false, now - 60_000)).assertStatus(204)
    await user.refresh()
    assert.isNotNull(user.bannedAt)

    ;(await sendUserUpdated(client, user, false, now + 1_000)).assertStatus(204)
    await user.refresh()
    assert.isNull(user.bannedAt)
    ;(await client.get('/api/v1/me').loginAs(user)).assertStatus(200)
    const fresh = await User.findOrFail(user.id)
    assert.isNull(fresh.bannedAt)
  })
})
