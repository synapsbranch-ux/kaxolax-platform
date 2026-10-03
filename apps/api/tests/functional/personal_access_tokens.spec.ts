import { createHash } from 'node:crypto'
import {
  createdPersonalAccessTokenResponseSchema,
  PERSONAL_ACCESS_TOKEN_MAX_ACTIVE,
  PERSONAL_ACCESS_TOKEN_MAX_CREATED,
  personalAccessTokensResponseSchema,
} from '@kaxolax/contracts'
import testUtils from '@adonisjs/core/services/test_utils'
import db from '@adonisjs/lucid/services/db'
import { test } from '@japa/runner'
import type { ApiClient } from '@japa/api-client'
import { DateTime } from 'luxon'
import PersonalAccessToken from '#models/personal_access_token'
import type User from '#models/user'
import {
  createPersonalAccessToken,
  tokenAllows,
  verifyPersonalAccessToken,
} from '#services/personal_access_tokens'
import { createProject } from '#services/project_service'
import { createUser } from '#tests/helpers'

/** Jeton inséré directement (secret jamais utilisé), révoqué, à la date de création donnée. */
async function insertRevoked(user: User, index: number, createdAt: DateTime, revokedAt: DateTime) {
  return PersonalAccessToken.create({
    userId: user.id,
    name: `Old ${String(index)}`,
    tokenPrefix: `kxp_${createHash('sha256')
      .update(`${user.id}:${String(index)}`)
      .digest('hex')
      .slice(0, 12)}`,
    tokenHash: createHash('sha256')
      .update(`${user.id}:${String(index)}`)
      .digest('hex'),
    scopes: ['read'],
    projectIds: null,
    expiresAt: createdAt.plus({ days: 90 }),
    lastUsedAt: null,
    revokedAt,
    createdAt,
  })
}

async function create(client: ApiClient, user: User, body: Record<string, unknown>) {
  return client.post('/api/v1/me/tokens').json(body).loginAs(user)
}

test.group('personal access tokens', (group) => {
  group.each.setup(() => testUtils.db().wrapInGlobalTransaction())

  test('shows the secret once and stores only its SHA-256 hash', async ({ client, assert }) => {
    const user = await createUser()
    const response = await create(client, user, { name: ' Claude Desktop ', scopes: ['read'] })
    response.assertStatus(201)
    assert.equal(response.header('cache-control'), 'no-store')
    const created = createdPersonalAccessTokenResponseSchema.parse(response.body())
    assert.equal(created.token.name, 'Claude Desktop')
    assert.isTrue(created.secret.startsWith(created.token.prefix))
    assert.isNull(created.token.projectIds)
    const days = DateTime.fromISO(created.token.expiresAt).diff(DateTime.utc(), 'days').days
    assert.closeTo(days, 90, 0.01)

    const row = (await db.from('personal_access_tokens').where('id', created.token.id).first()) as {
      token_hash: string
      token_prefix: string
    }
    assert.equal(row.token_hash, createHash('sha256').update(created.secret).digest('hex'))
    assert.notInclude(JSON.stringify(row), created.secret.slice(created.token.prefix.length))

    const list = await client.get('/api/v1/me/tokens').loginAs(user)
    list.assertStatus(200)
    const { tokens } = personalAccessTokensResponseSchema.parse(list.body())
    assert.deepEqual(
      tokens.map((token) => token.id),
      [created.token.id],
    )
    assert.notInclude(JSON.stringify(list.body()), created.secret)
    assert.notProperty(list.body().tokens[0] as object, 'tokenHash')
  })

  test('verifies a token in constant time, and only a valid one', async ({ assert }) => {
    const user = await createUser()
    const { token, secret } = await createPersonalAccessToken(user, {
      name: 'MCP',
      scopes: ['read'],
      projectIds: null,
      expiresInDays: 30,
    })
    const verified = await verifyPersonalAccessToken(secret)
    assert.equal(verified.status, 'valid')
    if (verified.status === 'valid') assert.equal(verified.user.id, user.id)
    assert.isNotNull((await PersonalAccessToken.findOrFail(token.id)).lastUsedAt)

    const tampered = `${secret.slice(0, -1)}${secret.endsWith('A') ? 'B' : 'A'}`
    assert.equal((await verifyPersonalAccessToken(tampered)).status, 'invalid')
    const unknownPrefix = `kxp_${'Z'.repeat(12)}${secret.slice(16)}`
    assert.equal((await verifyPersonalAccessToken(unknownPrefix)).status, 'invalid')
    for (const malformed of ['', 'Bearer x', secret.slice(1), `${secret}x`]) {
      assert.equal((await verifyPersonalAccessToken(malformed)).status, 'invalid')
    }

    // Expiration : refusé après la date.
    const later = DateTime.utc().plus({ days: 31 })
    assert.equal((await verifyPersonalAccessToken(secret, later)).status, 'expired')

    // Compte banni : refusé.
    user.bannedAt = DateTime.utc()
    await user.save()
    assert.equal((await verifyPersonalAccessToken(secret)).status, 'account_disabled')
  })

  test('limits a token to its scopes and projects', async ({ client, assert }) => {
    const user = await createUser()
    const allowed = await createProject(user, 'Allowed')
    const other = await createProject(user, 'Other')
    const response = await create(client, user, {
      name: 'Read one project',
      scopes: ['read'],
      projectIds: [allowed.id],
    })
    response.assertStatus(201)
    const { token } = createdPersonalAccessTokenResponseSchema.parse(response.body())
    const stored = await PersonalAccessToken.findOrFail(token.id)
    assert.deepEqual(stored.projectIds, [allowed.id])
    assert.deepEqual(stored.scopes, ['read'])
    assert.isTrue(tokenAllows(stored, allowed.id, 'read'))
    assert.isFalse(tokenAllows(stored, allowed.id, 'write'))
    assert.isFalse(tokenAllows(stored, other.id, 'read'))
    // `write` inclut `read` ; sans liste de projets : tous.
    assert.isTrue(tokenAllows({ scopes: ['write'], projectIds: null }, other.id, 'read'))

    // Un projet dont le compte n'est pas membre : refusé.
    const stranger = await createUser()
    const foreign = await createProject(stranger, 'Foreign')
    const refused = await create(client, user, {
      name: 'Foreign',
      scopes: ['write'],
      projectIds: [allowed.id, foreign.id],
    })
    refused.assertStatus(422)
    refused.assertBodyContains({ code: 'E_TOKEN_INVALID_PROJECT' })

    const invalid = await create(client, user, { name: 'x', scopes: ['admin'] })
    invalid.assertStatus(422)
    invalid.assertBodyContains({ code: 'E_VALIDATION_ERROR' })
  })

  test('revokes a token of the account, idempotently', async ({ client, assert }) => {
    const user = await createUser()
    const { token, secret } = await createPersonalAccessToken(user, {
      name: 'To revoke',
      scopes: ['write'],
      projectIds: null,
      expiresInDays: 7,
    })
    const stranger = await createUser()
    const foreign = await client.delete(`/api/v1/me/tokens/${token.id}`).loginAs(stranger)
    foreign.assertStatus(404)
    foreign.assertBodyContains({ code: 'E_TOKEN_NOT_FOUND' })
    ;(await client.delete('/api/v1/me/tokens/not-a-uuid').loginAs(user)).assertStatus(404)

    const revoked = await client.delete(`/api/v1/me/tokens/${token.id}`).loginAs(user)
    revoked.assertStatus(204)
    assert.equal((await verifyPersonalAccessToken(secret)).status, 'revoked')
    ;(await client.delete(`/api/v1/me/tokens/${token.id}`).loginAs(user)).assertStatus(204)

    const list = await client.get('/api/v1/me/tokens').loginAs(user)
    assert.isNotNull(personalAccessTokensResponseSchema.parse(list.body()).tokens[0]?.revokedAt)
  })

  test('caps the active tokens of an account', async ({ client, assert }) => {
    const user = await createUser()
    for (let index = 0; index < PERSONAL_ACCESS_TOKEN_MAX_ACTIVE; index++) {
      await createPersonalAccessToken(user, {
        name: `Token ${String(index)}`,
        scopes: ['read'],
        projectIds: null,
        expiresInDays: 1,
      })
    }
    const refused = await create(client, user, { name: 'One too many', scopes: ['read'] })
    refused.assertStatus(409)
    refused.assertBodyContains({ code: 'E_TOKEN_LIMIT' })
    // Un jeton révoqué libère une place.
    const first = await PersonalAccessToken.query().where('userId', user.id).firstOrFail()
    first.revokedAt = DateTime.utc()
    await first.save()
    ;(await create(client, user, { name: 'Replacement', scopes: ['read'] })).assertStatus(201)
    assert.lengthOf(
      await PersonalAccessToken.query().where('userId', user.id),
      PERSONAL_ACCESS_TOKEN_MAX_ACTIVE + 1,
    )
  })

  test('rate limits creations, revoked tokens included', async ({ client, assert }) => {
    const user = await createUser()
    const now = DateTime.utc()
    for (let index = 0; index < PERSONAL_ACCESS_TOKEN_MAX_CREATED; index++) {
      await insertRevoked(user, index, now.minus({ hours: 1 }), now.minus({ minutes: 30 }))
    }
    // Aucun jeton actif, mais la boucle « créer, révoquer » s'arrête.
    const refused = await create(client, user, { name: 'Again', scopes: ['read'] })
    refused.assertStatus(429)
    refused.assertBodyContains({ code: 'E_TOKEN_RATE_LIMIT' })
    assert.lengthOf(
      await PersonalAccessToken.query().where('userId', user.id),
      PERSONAL_ACCESS_TOKEN_MAX_CREATED,
    )
    // Créations hors de la fenêtre glissante : de nouveau possible.
    await PersonalAccessToken.query()
      .where('userId', user.id)
      .update({ createdAt: now.minus({ days: 31 }).toSQL() })
    ;(await create(client, user, { name: 'Later', scopes: ['read'] })).assertStatus(201)
  })

  test('purges tokens revoked or expired long ago and hides them', async ({ client, assert }) => {
    const user = await createUser()
    const now = DateTime.utc()
    const old = await insertRevoked(user, 0, now.minus({ days: 60 }), now.minus({ days: 31 }))
    const recent = await insertRevoked(user, 1, now.minus({ days: 60 }), now.minus({ days: 2 }))
    const expired = await insertRevoked(user, 2, now.minus({ days: 200 }), now)
    expired.revokedAt = null
    expired.expiresAt = now.minus({ days: 40 })
    await expired.save()

    const list = await client.get('/api/v1/me/tokens').loginAs(user)
    list.assertStatus(200)
    assert.deepEqual(
      personalAccessTokensResponseSchema.parse(list.body()).tokens.map((token) => token.id),
      [recent.id],
    )

    ;(await create(client, user, { name: 'New', scopes: ['read'] })).assertStatus(201)
    const ids = (await PersonalAccessToken.query().where('userId', user.id)).map((t) => t.id)
    assert.notInclude(ids, old.id)
    assert.notInclude(ids, expired.id)
    assert.include(ids, recent.id)
    assert.lengthOf(ids, 2)
  })
})
