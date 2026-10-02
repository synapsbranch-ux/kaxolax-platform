import { z } from 'zod'

/**
 * Authentification entre l'API et le Worker de compilation, avec un secret partagé
 * (`COMPILE_WORKER_SECRET`). WebCrypto seulement : le même code tourne dans Node.js et dans le
 * runtime Workers. Chaque usage signe un message préfixé par son propre domaine, pour qu'une
 * signature d'un sens ne soit jamais acceptée dans l'autre.
 */

/** Durée de vie d'un jeton API → Worker. */
export const COMPILE_WORKER_TOKEN_TTL_SECONDS = 60
/** Écart toléré entre l'horodatage d'un rappel Worker → API et l'horloge de l'API. */
export const CALLBACK_MAX_SKEW_SECONDS = 300

export const CALLBACK_TIMESTAMP_HEADER = 'x-kaxolax-timestamp'
export const CALLBACK_SIGNATURE_HEADER = 'x-kaxolax-signature'

const TOKEN_VERSION = 'v1'
const TOKEN_DOMAIN = 'kaxolax-compile-worker-token'
const CALLBACK_DOMAIN = 'kaxolax-compile-callback'

export const compileWorkerTokenClaimsSchema = z.object({
  aud: z.literal('compile-worker'),
  projectId: z.uuid(),
  /** Expiration, en secondes depuis l'époque Unix. */
  exp: z.number().int().positive(),
})
export type CompileWorkerTokenClaims = z.infer<typeof compileWorkerTokenClaimsSchema>

const encoder = new TextEncoder()

function toBase64Url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
}

function fromBase64Url(value: string): Uint8Array<ArrayBuffer> | null {
  if (!/^[A-Za-z0-9_-]*$/.test(value)) return null
  const padded = value.replaceAll('-', '+').replaceAll('_', '/')
  try {
    const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4))
    return Uint8Array.from(binary, (char) => char.charCodeAt(0))
  } catch {
    return null
  }
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  )
}

async function sign(secret: string, message: string): Promise<string> {
  const signature = await crypto.subtle.sign('HMAC', await hmacKey(secret), encoder.encode(message))
  return toBase64Url(new Uint8Array(signature))
}

/** Vérification à temps constant (crypto.subtle.verify). */
async function verify(secret: string, message: string, signature: string): Promise<boolean> {
  const bytes = fromBase64Url(signature)
  if (bytes?.length !== 32) return false
  return crypto.subtle.verify('HMAC', await hmacKey(secret), bytes, encoder.encode(message))
}

const nowSeconds = () => Math.floor(Date.now() / 1000)

/** Jeton court `v1.<charge base64url>.<HMAC base64url>` porté par chaque appel API → Worker. */
export async function signCompileWorkerToken(
  projectId: string,
  secret: string,
  now: number = nowSeconds(),
): Promise<string> {
  const claims = compileWorkerTokenClaimsSchema.parse({
    aud: 'compile-worker',
    projectId,
    exp: now + COMPILE_WORKER_TOKEN_TTL_SECONDS,
  })
  const payload = toBase64Url(encoder.encode(JSON.stringify(claims)))
  const signature = await sign(secret, `${TOKEN_DOMAIN}.${TOKEN_VERSION}.${payload}`)
  return `${TOKEN_VERSION}.${payload}.${signature}`
}

/**
 * Claims d'un jeton valide, non expiré, et dont la durée de vie restante ne dépasse pas celle
 * d'un jeton émis maintenant (un jeton à très longue durée ne passe pas) ; sinon null.
 */
export async function verifyCompileWorkerToken(
  token: string,
  secret: string,
  now: number = nowSeconds(),
): Promise<CompileWorkerTokenClaims | null> {
  const [version, payload, signature, ...rest] = token.split('.')
  if (version !== TOKEN_VERSION || !payload || !signature || rest.length > 0) return null
  if (!(await verify(secret, `${TOKEN_DOMAIN}.${TOKEN_VERSION}.${payload}`, signature))) {
    return null
  }
  const bytes = fromBase64Url(payload)
  if (bytes === null) return null
  try {
    const claims = compileWorkerTokenClaimsSchema.parse(JSON.parse(new TextDecoder().decode(bytes)))
    if (claims.exp <= now || claims.exp > now + COMPILE_WORKER_TOKEN_TTL_SECONDS + 5) return null
    return claims
  } catch {
    return null
  }
}

/** En-têtes signés d'un rappel Worker → API : horodatage et HMAC du corps brut. */
export async function signCallback(
  body: string,
  secret: string,
  now: number = nowSeconds(),
): Promise<Record<string, string>> {
  const timestamp = String(now)
  const signature = await sign(secret, `${CALLBACK_DOMAIN}.${TOKEN_VERSION}.${timestamp}.${body}`)
  return {
    [CALLBACK_TIMESTAMP_HEADER]: timestamp,
    [CALLBACK_SIGNATURE_HEADER]: `${TOKEN_VERSION}=${signature}`,
  }
}

/**
 * Vérifie un rappel : signature du corps brut et horodatage à moins de 5 minutes. Le rejeu dans
 * cette fenêtre est arrêté par l'API (numéro de séquence par compilation, états finaux figés).
 */
export async function verifyCallback(
  body: string,
  headers: { timestamp: string | undefined; signature: string | undefined },
  secret: string,
  now: number = nowSeconds(),
): Promise<boolean> {
  const { timestamp, signature } = headers
  if (timestamp === undefined || signature === undefined || !/^\d{1,12}$/.test(timestamp)) {
    return false
  }
  if (Math.abs(now - Number(timestamp)) > CALLBACK_MAX_SKEW_SECONDS) return false
  const prefix = `${TOKEN_VERSION}=`
  if (!signature.startsWith(prefix)) return false
  return verify(
    secret,
    `${CALLBACK_DOMAIN}.${TOKEN_VERSION}.${timestamp}.${body}`,
    signature.slice(prefix.length),
  )
}
