import { createHmac, generateKeyPairSync, randomUUID, sign } from 'node:crypto'

/**
 * Instance Clerk simulée pour les tests : paire RSA générée au lancement (bin/test.ts), clé
 * publique dans CLERK_JWT_KEY. Les jetons ont la forme de vrais jetons de session Clerk (RS256)
 * et passent par la vraie vérification de @clerk/backend.
 */
export const TEST_APP_ORIGIN = 'http://localhost:3000'
export const TEST_WEBHOOK_SECRET = `whsec_${Buffer.from('kaxolax-test-webhook-secret-0123').toString('base64')}`

export function generateClerkKeys() {
  return generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  })
}

const base64url = (value: string | Buffer) => Buffer.from(value).toString('base64url')

export function signJwt(claims: Record<string, unknown>, privateKey = testPrivateKey()): string {
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: 'ins_test' }))
  const payload = base64url(JSON.stringify(claims))
  const signature = sign('sha256', Buffer.from(`${header}.${payload}`), privateKey)
  return `${header}.${payload}.${base64url(signature)}`
}

function testPrivateKey(): string {
  const key = process.env.KAXOLAX_TEST_CLERK_PRIVATE_KEY
  if (!key) throw new Error('KAXOLAX_TEST_CLERK_PRIVATE_KEY is set by bin/test.ts')
  return key
}

/** Claims d'un jeton de session Clerk valide (60 s), modifiables par test. */
export function sessionClaims(sub: string, overrides: Record<string, unknown> = {}) {
  const now = Math.floor(Date.now() / 1000)
  return {
    sub,
    azp: TEST_APP_ORIGIN,
    iss: 'https://test.clerk.accounts.dev',
    sid: `sess_${randomUUID()}`,
    sts: 'active',
    iat: now,
    nbf: now - 5,
    exp: now + 60,
    ...overrides,
  }
}

/** En-têtes Standard Webhooks (svix-*) signés comme le fait Clerk. */
export function signWebhook(
  body: string,
  secret = TEST_WEBHOOK_SECRET,
  id = `msg_${randomUUID()}`,
) {
  const timestamp = String(Math.floor(Date.now() / 1000))
  const key = Buffer.from(secret.replace(/^whsec_/, ''), 'base64')
  const signature = createHmac('sha256', key).update(`${id}.${timestamp}.${body}`).digest('base64')
  return { 'svix-id': id, 'svix-timestamp': timestamp, 'svix-signature': `v1,${signature}` }
}
