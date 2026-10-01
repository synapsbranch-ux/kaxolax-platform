import { randomUUID } from 'node:crypto'
import { ClerkGuard } from '#auth/clerk_guard'
import type User from '#models/user'
import { sessionClaims, signJwt } from '#tests/clerk_keys'

/** Relie l'utilisateur à un compte Clerk fictif si besoin, puis signe un jeton pour lui. */
export async function clerkTokenFor(user: User, overrides: Record<string, unknown> = {}) {
  if (!user.clerkUserId) {
    user.clerkUserId = `user_${randomUUID().replaceAll('-', '')}`
    await user.save()
  }
  return signJwt(sessionClaims(user.clerkUserId, overrides))
}

/** `.loginAs(user)` des tests envoie un jeton Clerk (guard par défaut). */
export function installClerkTestTokens() {
  ClerkGuard.testTokenFactory = (user) => clerkTokenFor(user)
}
