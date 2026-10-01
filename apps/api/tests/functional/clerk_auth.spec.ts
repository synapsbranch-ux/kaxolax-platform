import { randomUUID } from 'node:crypto'
import testUtils from '@adonisjs/core/services/test_utils'
import { test } from '@japa/runner'
import { DateTime } from 'luxon'
import User from '#models/user'
import { clerkTokenFor } from '#tests/clerk'
import { generateClerkKeys, sessionClaims, signJwt } from '#tests/clerk_keys'
import { createUser, PASSWORD, uniqueEmail } from '#tests/helpers'

const newClerkId = () => `user_${randomUUID().replaceAll('-', '')}`
const bearer = (token: string) => `Bearer ${token}`

test.group('clerk: session tokens', (group) => {
  group.each.setup(() => testUtils.db().wrapInGlobalTransaction())

  test('a valid token authenticates its local user', async ({ client, assert }) => {
    const user = await createUser()
    const token = await clerkTokenFor(user)
    const response = await client.get('/api/v1/me').header('authorization', bearer(token))
    response.assertStatus(200)
    assert.equal(response.body().user.id, user.id)
    assert.equal(response.body().user.email, user.email)
  })

  test('mutations with a token need no CSRF token', async ({ client }) => {
    const user = await createUser()
    const response = await client
      .post('/api/v1/projects')
      .header('authorization', bearer(await clerkTokenFor(user)))
      .json({ name: 'Sans CSRF' })
    response.assertStatus(201)
  })

  test('refuses expired, not yet valid, forged and foreign tokens', async ({ client }) => {
    const user = await createUser()
    await clerkTokenFor(user) // relie l'utilisateur à un compte Clerk
    const sub = String(user.clerkUserId)
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
  })

  test('a bearer request never falls back to the session cookie', async ({ client }) => {
    const user = await createUser()
    const response = await client
      .get('/api/v1/me')
      .withGuard('web')
      .loginAs(user)
      .header('authorization', bearer('not-a-jwt'))
    response.assertStatus(401)
  })

  test('creates the local user on first sight from verified claims', async ({ client, assert }) => {
    const clerkUserId = newClerkId()
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
    assert.isNull(user.passwordHash)
  })

  test('links a stage 1 account by verified email', async ({ client, assert }) => {
    const existing = await createUser()
    const clerkUserId = newClerkId()
    const token = signJwt(
      sessionClaims(clerkUserId, { email: existing.email, email_verified: true }),
    )
    const response = await client.get('/api/v1/me').header('authorization', bearer(token))
    response.assertStatus(200)
    assert.equal(response.body().user.id, existing.id)
    await existing.refresh()
    assert.equal(existing.clerkUserId, clerkUserId)
  })

  test('refuses an unknown user whose email is missing or unverified', async ({
    client,
    assert,
  }) => {
    const existing = await createUser()
    for (const extra of [{}, { email: existing.email, email_verified: false }]) {
      const token = signJwt(sessionClaims(newClerkId(), extra))
      const response = await client.get('/api/v1/me').header('authorization', bearer(token))
      response.assertStatus(401)
    }
    await existing.refresh()
    assert.isNull(existing.clerkUserId)
  })

  test('refuses a deleted user', async ({ client }) => {
    const user = await createUser()
    const token = await clerkTokenFor(user)
    user.deletedAt = DateTime.utc()
    await user.save()
    const response = await client.get('/api/v1/me').header('authorization', bearer(token))
    response.assertStatus(401)
  })

  test('a session login is refused for an account without password', async ({ client }) => {
    const email = uniqueEmail('clerk-only')
    await User.create({
      email,
      clerkUserId: newClerkId(),
      fullName: null,
      emailVerifiedAt: DateTime.utc(),
    })
    const response = await client
      .post('/api/v1/auth/login')
      .json({ email, password: PASSWORD })
      .withCsrfToken()
    response.assertStatus(400)
  })
})
