import testUtils from '@adonisjs/core/services/test_utils'
import mail from '@adonisjs/mail/services/main'
import { test } from '@japa/runner'
import { DateTime } from 'luxon'
import ResetPasswordNotification from '#mails/reset_password_notification'
import VerifyEmailNotification from '#mails/verify_email_notification'
import AuthToken from '#models/auth_token'
import User from '#models/user'
import { createUser, PASSWORD, tokenFromUrl, uniqueEmail } from '#tests/helpers'

test.group('auth: register and verify email', (group) => {
  group.each.setup(() => testUtils.db().wrapInGlobalTransaction())

  test('registers a user with a lowercase email and sends a verification email', async ({
    client,
    assert,
  }) => {
    const { mails } = mail.fake()
    const email = uniqueEmail('Mixed.Case')
    const response = await client
      .post('/api/v1/auth/register')
      .json({ email: `  ${email.toUpperCase()} `, password: PASSWORD, fullName: 'Grace Hopper' })
      .withCsrfToken()
    response.assertStatus(201)
    const user = await User.findByOrFail('email', email.toLowerCase())
    assert.isNull(user.emailVerifiedAt)
    assert.notEqual(user.passwordHash, PASSWORD)
    assert.notProperty(response.body().user, 'passwordHash')
    mails.assertSent(VerifyEmailNotification, (message) =>
      message.url.includes('/verify-email?token='),
    )
    // Seul le hash du jeton est stocké.
    const [sent] = mails.sent() as VerifyEmailNotification[]
    const token = await AuthToken.findByOrFail('userId', user.id)
    assert.notEqual(token.tokenHash, tokenFromUrl(sent?.url ?? ''))
    mail.restore()
  })

  test('refuses a duplicate email, an invalid email and a short password', async ({ client }) => {
    const existing = await createUser()
    const duplicate = await client
      .post('/api/v1/auth/register')
      .json({ email: existing.email, password: PASSWORD })
      .withCsrfToken()
    duplicate.assertStatus(422)
    const invalid = await client
      .post('/api/v1/auth/register')
      .json({ email: 'not-an-email', password: 'short' })
      .withCsrfToken()
    invalid.assertStatus(422)
    invalid.assertBodyContains({ errors: [{ field: 'email' }, { field: 'password' }] })
  })

  test('verifies the email with a single-use token', async ({ client, assert }) => {
    const { mails } = mail.fake()
    const email = uniqueEmail()
    await client.post('/api/v1/auth/register').json({ email, password: PASSWORD }).withCsrfToken()
    const [sent] = mails.sent() as VerifyEmailNotification[]
    const token = tokenFromUrl(sent?.url ?? '')
    mail.restore()

    const verified = await client.post('/api/v1/auth/verify-email').json({ token }).withCsrfToken()
    verified.assertStatus(200)
    assert.isNotNull(verified.body().user.emailVerifiedAt)

    const reused = await client.post('/api/v1/auth/verify-email').json({ token }).withCsrfToken()
    reused.assertStatus(400)
    reused.assertBodyContains({ code: 'E_INVALID_TOKEN' })
  })

  test('refuses an expired or unknown token', async ({ client }) => {
    const { mails } = mail.fake()
    const email = uniqueEmail()
    await client.post('/api/v1/auth/register').json({ email, password: PASSWORD }).withCsrfToken()
    const [sent] = mails.sent() as VerifyEmailNotification[]
    mail.restore()
    await AuthToken.query().update({ expiresAt: DateTime.utc().minus({ minutes: 1 }).toSQL() })
    const expired = await client
      .post('/api/v1/auth/verify-email')
      .json({ token: tokenFromUrl(sent?.url ?? '') })
      .withCsrfToken()
    expired.assertStatus(400)
    const unknown = await client
      .post('/api/v1/auth/verify-email')
      .json({ token: 'this-token-does-not-exist-anywhere' })
      .withCsrfToken()
    unknown.assertStatus(400)
  })

  test('resends the verification email without revealing whether the account exists', async ({
    client,
  }) => {
    const { mails } = mail.fake()
    const pending = await createUser({ verified: false })
    const verified = await createUser()
    for (const email of [pending.email, verified.email, uniqueEmail('nobody')]) {
      const response = await client
        .post('/api/v1/auth/resend-verification')
        .json({ email })
        .withCsrfToken()
      response.assertStatus(202)
    }
    mails.assertSentCount(VerifyEmailNotification, 1)
    mail.restore()
  })
})

test.group('auth: login, session and logout', (group) => {
  group.each.setup(() => testUtils.db().wrapInGlobalTransaction())

  test('refuses to log in before the email is verified', async ({ client }) => {
    const user = await createUser({ verified: false })
    const response = await client
      .post('/api/v1/auth/login')
      .json({ email: user.email, password: PASSWORD })
      .withCsrfToken()
    response.assertStatus(403)
    response.assertBodyContains({ code: 'E_EMAIL_NOT_VERIFIED' })
  })

  test('logs in with a session cookie, reads /me, then logs out', async ({ client, assert }) => {
    const user = await createUser()
    const login = await client
      .post('/api/v1/auth/login')
      .json({ email: user.email.toUpperCase(), password: PASSWORD })
      .withCsrfToken()
    login.assertStatus(200)
    login.assertBodyContains({ user: { id: user.id, email: user.email } })
    const cookie = login.cookie('kaxolax-session')
    assert.exists(cookie)
    assert.include(String(login.headers()['set-cookie']), 'HttpOnly')

    const me = await client.get('/api/v1/auth/me').loginAs(user)
    me.assertStatus(200)
    me.assertBodyContains({ user: { email: user.email } })

    const logout = await client.post('/api/v1/auth/logout').loginAs(user).withCsrfToken()
    logout.assertStatus(204)
  })

  test('rejects a wrong password and anonymous calls to /me', async ({ client }) => {
    const user = await createUser()
    const wrong = await client
      .post('/api/v1/auth/login')
      .json({ email: user.email, password: 'wrong password!' })
      .withCsrfToken()
    wrong.assertStatus(400)
    const me = await client.get('/api/v1/auth/me')
    me.assertStatus(401)
  })

  test('requires a CSRF token for state-changing requests', async ({ client }) => {
    const user = await createUser()
    const response = await client
      .post('/api/v1/auth/login')
      .json({ email: user.email, password: PASSWORD })
    response.assertStatus(403)
  })

  test('rate limits login attempts', async ({ client }) => {
    const email = uniqueEmail('bruteforce')
    const statuses: number[] = []
    for (let attempt = 0; attempt < 6; attempt++) {
      const response = await client
        .post('/api/v1/auth/login')
        .json({ email, password: 'guess' + String(attempt) })
        .withCsrfToken()
      statuses.push(response.status())
    }
    const [last] = statuses.slice(-1)
    if (last !== 429) throw new Error(`expected 429 on the 6th attempt, got ${statuses.join(', ')}`)
  })
})

test.group('auth: password reset', (group) => {
  group.each.setup(() => testUtils.db().wrapInGlobalTransaction())

  test('resets the password with the emailed token', async ({ client, assert }) => {
    const { mails } = mail.fake()
    const user = await createUser()
    const forgot = await client
      .post('/api/v1/auth/forgot-password')
      .json({ email: user.email })
      .withCsrfToken()
    forgot.assertStatus(202)
    const [sent] = mails.sent() as ResetPasswordNotification[]
    assert.instanceOf(sent, ResetPasswordNotification)
    mail.restore()
    const token = tokenFromUrl(sent?.url ?? '')

    const reset = await client
      .post('/api/v1/auth/reset-password')
      .json({ token, password: 'a brand new password' })
      .withCsrfToken()
    reset.assertStatus(200)

    const oldPassword = await client
      .post('/api/v1/auth/login')
      .json({ email: user.email, password: PASSWORD })
      .withCsrfToken()
    oldPassword.assertStatus(400)
    const newPassword = await client
      .post('/api/v1/auth/login')
      .json({ email: user.email, password: 'a brand new password' })
      .withCsrfToken()
    newPassword.assertStatus(200)

    const reused = await client
      .post('/api/v1/auth/reset-password')
      .json({ token, password: 'yet another password' })
      .withCsrfToken()
    reused.assertStatus(400)
  })

  test('answers the same way for an unknown email', async ({ client }) => {
    const { mails } = mail.fake()
    const response = await client
      .post('/api/v1/auth/forgot-password')
      .json({ email: uniqueEmail('ghost') })
      .withCsrfToken()
    response.assertStatus(202)
    mails.assertNoneSent()
    mail.restore()
  })
})
