import { createHmac, timingSafeEqual } from 'node:crypto'
import { type RealtimeTokenClaims, realtimeTokenClaimsSchema } from '@kaxolax/contracts'

/**
 * Jeton temps réel : `v1.<charge utile base64url>.<HMAC-SHA256 base64url>`, signé par l'API avec un
 * secret partagé avec le service temps réel. Réservé à Node.js (import `@kaxolax/collab/token`).
 */
const VERSION = 'v1'

function sign(payload: string, secret: string): string {
  return createHmac('sha256', secret).update(`${VERSION}.${payload}`).digest('base64url')
}

export function signRealtimeToken(claims: RealtimeTokenClaims, secret: string): string {
  const payload = Buffer.from(JSON.stringify(realtimeTokenClaimsSchema.parse(claims))).toString(
    'base64url',
  )
  return `${VERSION}.${payload}.${sign(payload, secret)}`
}

/** Renvoie les claims d'un jeton valide et non expiré, sinon null. */
export function verifyRealtimeToken(
  token: string,
  secret: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): RealtimeTokenClaims | null {
  const [version, payload, signature, ...rest] = token.split('.')
  if (version !== VERSION || !payload || !signature || rest.length > 0) return null
  const expected = Buffer.from(sign(payload, secret))
  const provided = Buffer.from(signature)
  if (expected.length !== provided.length || !timingSafeEqual(expected, provided)) return null
  try {
    const claims = realtimeTokenClaimsSchema.parse(
      JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')),
    )
    return claims.exp > nowSeconds ? claims : null
  } catch {
    return null
  }
}
