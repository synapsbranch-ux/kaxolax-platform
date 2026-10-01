import { randomUUID } from 'node:crypto'
import User from '#models/user'
import { ensurePersonalWorkspace } from '#services/workspace_service'

export function uniqueEmail(prefix = 'user'): string {
  return `${prefix}-${randomUUID()}@example.com`
}

export function newClerkUserId(): string {
  return `user_${randomUUID().replaceAll('-', '')}`
}

/** Utilisateur de test, miroir d'un compte Clerk fictif, avec son workspace personnel. */
export async function createUser(options: { email?: string } = {}): Promise<User> {
  const user = await User.create({
    clerkUserId: newClerkUserId(),
    email: options.email ?? uniqueEmail(),
    fullName: 'Ada Lovelace',
  })
  await ensurePersonalWorkspace(user)
  return user
}
