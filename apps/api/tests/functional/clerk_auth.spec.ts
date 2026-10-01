import testUtils from '@adonisjs/core/services/test_utils'
import { test } from '@japa/runner'
import { DateTime } from 'luxon'
import User from '#models/user'
import { clerkTokenFor } from '#tests/clerk'
import { generateClerkKeys, sessionClaims, signJwt } from '#tests/clerk_keys'
import { createUser, newClerkUserId, uniqueEmail } from '#tests/helpers'

const bearer = (token: string) => `Bearer ${token}`

test.group('clerk: session tokens', (group) => {
  group.each.setup(() => testUtils.db().wrapInGlobalTransaction())

  test('a valid token authenticates its local user', async ({ client, assert }) => {
    const user = await createUser()
    const response = await client
      .get('/api/v1/me')
      .header('authorization', bearer(clerkTokenFor(user)))
    response.assertStatus(200)
    assert.equal(response.body().user.id, user.id)
    assert.equal(response.body().user.email, user.email)
  })

  test('mutations need no CSRF token and no cookie', async ({ client }) => {
    const user = await createUser()
    const response = await client
      .post('/api/v1/projects')
      .header('authorization', bearer(clerkTokenFor(user)))
      .json({ name: 'Sans CSRF' })
    response.assertStatus(201)
  })

  test('refuses a missing, expired, not yet valid, forged or foreign token', async ({ client }) => {
    const user = await createUser()
    const sub = user.clerkUserId
    const now = Math.floor(Date.now() / 1000)
    const otherInstance = generateClerkKeys()
    const refused = [
      signJwt(sessionClaims(sub, { iat: now - 120, nbf: now - 120, exp: now - 60 })),
      signJwt(sessionClaims(sub, { nbf: now + 600 })),
      signJwt(sessionClaims(sub), otherInstance.privateKey),
      signJwt(sessionClaims(sub, { azp: 'https://evil.example' })),
      signJwt(sessionClaims('')),
      signJwt(sessionClaims(sub, { sts: 'pending' })),
      `${signJwt(sessionClaims(sub)).slice(0, -4)}AAAA`,
      'not-a-jwt',
    ]
    for (const token of refused) {
      const response = await client.get('/api/v1/me').header('authorization', bearer(token))
      response.assertStatus(401)
    }
    ;(await client.get('/api/v1/me')).assertStatus(401)
  })

  test('creates the local user on first sight from verified claims', async ({ client, assert }) => {
    const clerkUserId = newClerkUserId()
    const email = uniqueEmail('first-sight').toUpperCase()
    const token = signJwt(
      sessionClaims(clerkUserId, {
        email,
        email_verified: true,
        name: 'Grace Hopper',
        picture: 'https://img.clerk.com/grace.png',
      }),
    )
    const response = await client.get('/api/v1/me').header('authorization', bearer(token))
    response.assertStatus(200)
    const user = await User.findByOrFail('clerkUserId', clerkUserId)
    assert.equal(user.email, email.toLowerCase())
    assert.equal(user.fullName, 'Grace Hopper')
    assert.equal(user.avatarUrl, 'https://img.clerk.com/grace.png')
    assert.equal(response.body().user.id, user.id)

    // Booléen rendu en texte par le modèle de claims du Dashboard : accepté aussi.
    const textual = signJwt(
      sessionClaims(newClerkUserId(), { email: uniqueEmail(), email_verified: 'true' }),
    )
    ;(await client.get('/api/v1/me').header('authorization', bearer(textual))).assertStatus(200)
  })

  test('refuses an unknown user whose email is missing, unverified or already used', async ({
    client,
    assert,
  }) => {
    const existing = await createUser()
    const fresh = uniqueEmail()
    const cases: [Record<string, unknown>, number][] = [
      [{}, 401],
      [{ email: fresh, email_verified: false }, 401],
      [{ email: fresh, email_verified: 'false' }, 401],
      [{ email: fresh }, 401],
      // Email déjà pris par un autre compte Clerk : aucun rattachement implicite.
      [{ email: existing.email, email_verified: true }, 409],
    ]
    for (const [claims, status] of cases) {
      const token = signJwt(sessionClaims(newClerkUserId(), claims))
      const response = await client.get('/api/v1/me').header('authorization', bearer(token))
      response.assertStatus(status)
    }
    assert.lengthOf(await User.query().where('email', fresh), 0)
  })

  test('refuses a deleted user', async ({ client }) => {
    const user = await createUser()
    const token = clerkTokenFor(user)
    user.deletedAt = DateTime.utc()
    await user.save()
    const response = await client.get('/api/v1/me').header('authorization', bearer(token))
    response.assertStatus(401)
  })

  test('the stage 1 session routes are gone', async ({ client }) => {
    for (const path of ['/api/v1/auth/login', '/api/v1/auth/register', '/api/v1/auth/logout']) {
      ;(await client.post(path).json({})).assertStatus(404)
    }
    ;(await client.get('/api/v1/auth/me')).assertStatus(404)
  })
})
