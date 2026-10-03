import { createHmac, timingSafeEqual } from 'node:crypto'
import {
  type RealtimeTokenClaims,
  realtimeTokenClaimsSchema,
  type UserRealtimeTokenClaims,
  userRealtimeTokenClaimsSchema,
} from '@kaxolax/contracts'

/**
 * Jeton temps réel : `v1.<charge utile base64url>.<HMAC-SHA256 base64url>`, signé par l'API avec un
 * secret partagé avec le service temps réel. Réservé à Node.js (import `@kaxolax/collab/token`).
 * Deux formes de charge utile, qui ne se valident pas l'une l'autre : jeton d'un projet
 * (documents et meta du projet) et jeton du canal de l'utilisateur (`scope: 'user'`).
 */
const VERSION = 'v1'

/** Schéma zod des claims (seul `parse` sert ici). */
interface ClaimsSchema<T> {
  parse: (value: unknown) => T
}

function sign(payload: string, secret: string): string {
  return createHmac('sha256', secret).update(`${VERSION}.${payload}`).digest('base64url')
}

function signClaims<T extends { exp: number }>(
  schema: ClaimsSchema<T>,
  claims: T,
  secret: string,
): string {
  const payload = Buffer.from(JSON.stringify(schema.parse(claims))).toString('base64url')
  return `${VERSION}.${payload}.${sign(payload, secret)}`
}

function verifyClaims<T extends { exp: number }>(
  schema: ClaimsSchema<T>,
  token: string,
  secret: string,
  nowSeconds: number,
): T | null {
  const [version, payload, signature, ...rest] = token.split('.')
  if (version !== VERSION || !payload || !signature || rest.length > 0) return null
  const expected = Buffer.from(sign(payload, secret))
  const provided = Buffer.from(signature)
  if (expected.length !== provided.length || !timingSafeEqual(expected, provided)) return null
  try {
    const claims = schema.parse(JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')))
    return claims.exp > nowSeconds ? claims : null
  } catch {
    return null
  }
}

export function signRealtimeToken(claims: RealtimeTokenClaims, secret: string): string {
  return signClaims(realtimeTokenClaimsSchema, claims, secret)
}

/** Renvoie les claims d'un jeton de projet valide et non expiré, sinon null. */
export function verifyRealtimeToken(
  token: string,
  secret: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): RealtimeTokenClaims | null {
  return verifyClaims(realtimeTokenClaimsSchema, token, secret, nowSeconds)
}

/** Jeton du canal temps réel de l'utilisateur (`userChannelName`). */
export function signUserRealtimeToken(claims: UserRealtimeTokenClaims, secret: string): string {
  return signClaims(userRealtimeTokenClaimsSchema, claims, secret)
}

/** Renvoie les claims d'un jeton de canal utilisateur valide et non expiré, sinon null. */
export function verifyUserRealtimeToken(
  token: string,
  secret: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): UserRealtimeTokenClaims | null {
  return verifyClaims(userRealtimeTokenClaimsSchema, token, secret, nowSeconds)
}
