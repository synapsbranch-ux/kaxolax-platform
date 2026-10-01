import { randomUUID } from 'node:crypto'
import User from '#models/user'

export function uniqueEmail(prefix = 'user'): string {
  return `${prefix}-${randomUUID()}@example.com`
}

export function newClerkUserId(): string {
  return `user_${randomUUID().replaceAll('-', '')}`
}

/** Utilisateur de test, miroir d'un compte Clerk fictif. */
export async function createUser(options: { email?: string } = {}): Promise<User> {
  return User.create({
    clerkUserId: newClerkUserId(),
    email: options.email ?? uniqueEmail(),
    fullName: 'Ada Lovelace',
  })
}
