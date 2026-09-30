import { createHash, randomBytes } from 'node:crypto'
import db from '@adonisjs/lucid/services/db'
import { DateTime } from 'luxon'
import AuthToken, { type AuthTokenType } from '#models/auth_token'
import User from '#models/user'

const LIFETIME: Record<AuthTokenType, { hours: number }> = {
  email_verification: { hours: 24 },
  password_reset: { hours: 1 },
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

/**
 * Émet un jeton à usage unique (renvoyé en clair une seule fois, pour l'email) ; seul son hash est
 * stocké. Les jetons encore valides du même type pour cet utilisateur sont invalidés.
 */
export async function issueToken(user: User, type: AuthTokenType): Promise<string> {
  const token = randomBytes(32).toString('base64url')
  await db.transaction(async (trx) => {
    await AuthToken.query({ client: trx })
      .where({ userId: user.id, type })
      .whereNull('usedAt')
      .update({ usedAt: DateTime.utc().toSQL() })
    await AuthToken.create(
      {
        userId: user.id,
        type,
        tokenHash: hashToken(token),
        expiresAt: DateTime.utc().plus(LIFETIME[type]),
      },
      { client: trx },
    )
  })
  return token
}

/** Consomme un jeton valide (non expiré, jamais utilisé) et renvoie son utilisateur. */
export async function consumeToken(type: AuthTokenType, token: string): Promise<User | null> {
  return db.transaction(async (trx) => {
    const record = await AuthToken.query({ client: trx })
      .where({ tokenHash: hashToken(token), type })
      .whereNull('usedAt')
      .where('expiresAt', '>', DateTime.utc().toSQL())
      .forUpdate()
      .first()
    if (!record) return null
    record.usedAt = DateTime.utc()
    await record.useTransaction(trx).save()
    return User.find(record.userId, { client: trx })
  })
}
