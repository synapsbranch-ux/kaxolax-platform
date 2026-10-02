import { ADMIN_MFA_REQUIRED_ERROR, ADMIN_REQUIRED_ERROR, ADMIN_ROLE } from '@kaxolax/contracts'
import { Exception } from '@adonisjs/core/exceptions'
import logger from '@adonisjs/core/services/logger'
import type { ClerkSessionClaims } from '#auth/clerk_guard'
import clerkConfig from '#config/clerk'
import type ClerkBackend from '#services/clerk_backend'
import type { ClerkAccount } from '#services/clerk_backend'

export class AdminRequiredException extends Exception {
  static override status = 403
  static override code = ADMIN_REQUIRED_ERROR
  static override message = 'This area is reserved for administrators'
}

export class AdminMfaRequiredException extends Exception {
  static override status = 403
  static override code = ADMIN_MFA_REQUIRED_ERROR
  static override message = 'Administrators must enable and use multi-factor authentication'
}

/** Au-delà, le cache est vidé : il ne contient normalement que les quelques admins. */
const MAX_CACHED_ACCOUNTS = 1_000

/** État Clerk des admins (rôle, MFA activée), gardé `clerkConfig.adminStatusCacheMs`. */
const cache = new Map<string, { account: ClerkAccount | null; expiresAt: number }>()

async function cachedAccount(
  clerk: ClerkBackend,
  clerkUserId: string,
): Promise<ClerkAccount | null> {
  const now = Date.now()
  const hit = cache.get(clerkUserId)
  if (hit && hit.expiresAt > now) return hit.account
  // Une erreur de Clerk (502, 503) n'est pas mise en cache : la requête suivante réessaie.
  const account = await clerk.getAccount(clerkUserId)
  if (cache.size >= MAX_CACHED_ACCOUNTS) cache.clear()
  cache.set(clerkUserId, { account, expiresAt: now + clerkConfig.adminStatusCacheMs })
  return account
}

/** Oublie l'état mis en cache d'un compte (après une action de l'admin sur lui), ou de tous. */
export function forgetAdminStatus(clerkUserId?: string): void {
  if (clerkUserId === undefined) cache.clear()
  else cache.delete(clerkUserId)
}

function refuse(claims: ClerkSessionClaims, error: Exception, reason: string): never {
  logger.warn({ clerkUserId: claims.userId, reason }, 'admin access refused')
  throw error
}

/**
 * Accès à l'admin : rôle `admin` dans le jeton (claim `metadata.role`) et second facteur vérifié
 * pendant la session (claim `fva`), puis confirmation par l'API Backend de Clerk que le compte
 * est toujours admin et a la MFA activée (`twoFactorEnabled`), mise en cache une minute. Les
 * claims sont vérifiés en premier : un non-admin ne déclenche aucun appel à Clerk.
 */
export async function assertAdminAccess(
  clerk: ClerkBackend,
  claims: ClerkSessionClaims,
): Promise<void> {
  if (claims.role !== ADMIN_ROLE) {
    refuse(claims, new AdminRequiredException(), 'no admin role claim')
  }
  const secondFactorAge = claims.factorVerificationAge?.[1] ?? -1
  if (secondFactorAge < 0) {
    refuse(claims, new AdminMfaRequiredException(), 'second factor not verified in this session')
  }
  const account = await cachedAccount(clerk, claims.userId)
  if (account?.role !== ADMIN_ROLE) {
    refuse(claims, new AdminRequiredException(), 'admin role not confirmed by Clerk')
  }
  if (!account.twoFactorEnabled) {
    refuse(claims, new AdminMfaRequiredException(), 'multi-factor authentication disabled')
  }
}
