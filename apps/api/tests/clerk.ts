import { ClerkGuard } from '#auth/clerk_guard'
import type User from '#models/user'
import { sessionClaims, signJwt } from '#tests/clerk_keys'

/** Jeton de session Clerk valide pour l'utilisateur, signé par l'instance simulée. */
export function clerkTokenFor(user: User, overrides: Record<string, unknown> = {}): string {
  return signJwt(sessionClaims(user.clerkUserId, overrides))
}

/** `.loginAs(user)` des tests envoie un jeton Clerk (guard par défaut). */
export function installClerkTestTokens() {
  ClerkGuard.testTokenFactory = (user) => Promise.resolve(clerkTokenFor(user))
}
