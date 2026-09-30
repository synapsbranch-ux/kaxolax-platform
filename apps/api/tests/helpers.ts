import { randomUUID } from 'node:crypto'
import { DateTime } from 'luxon'
import User from '#models/user'

export const PASSWORD = 'correct horse battery staple'

export function uniqueEmail(prefix = 'user'): string {
  return `${prefix}-${randomUUID()}@example.com`
}

/** Utilisateur de test, email vérifié par défaut. */
export async function createUser(
  options: { verified?: boolean; email?: string } = {},
): Promise<User> {
  return User.create({
    email: options.email ?? uniqueEmail(),
    passwordHash: PASSWORD,
    fullName: 'Ada Lovelace',
    emailVerifiedAt: options.verified === false ? null : DateTime.utc(),
  })
}

/** Jeton contenu dans le lien d'un email (…?token=XYZ). */
export function tokenFromUrl(url: string): string {
  return new URL(url).searchParams.get('token') ?? ''
}
