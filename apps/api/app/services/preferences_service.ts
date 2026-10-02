import {
  MAX_PREFERENCES_BYTES,
  type ResolvedPreferences,
  resolvePreferences,
  safeMergePreferences,
  sanitizePreferences,
  type UserPreferences,
} from '@kaxolax/contracts'
import { Exception } from '@adonisjs/core/exceptions'
import db from '@adonisjs/lucid/services/db'
import UserPreference from '#models/user_preference'
import type User from '#models/user'
import { ZodValidationException } from '#validators/zod'

export class PreferencesTooLargeException extends Exception {
  static override status = 422
  static override code = 'E_PREFERENCES_TOO_LARGE'
  static override message = 'The preferences are too large'
}

/**
 * Préférences stockées d'un utilisateur. Une clé devenue invalide (schéma resserré depuis) est
 * écartée seule et reprend sa valeur par défaut ; les autres sont conservées, y compris lors de
 * la prochaine écriture.
 */
function parseStored(prefs: unknown): UserPreferences {
  return sanitizePreferences(prefs)
}

/** Préférences complètes de l'utilisateur, valeurs par défaut appliquées. */
export async function preferencesOf(user: User): Promise<ResolvedPreferences> {
  const row = await UserPreference.find(user.id)
  return resolvePreferences(parseStored(row?.prefs ?? {}))
}

/**
 * Fusionne `patch` (déjà validé) dans les préférences stockées et l'écrit. La ligne est créée
 * par `INSERT … ON CONFLICT DO NOTHING` puis verrouillée (`FOR UPDATE`) : deux modifications
 * simultanées sont appliquées l'une après l'autre, sans perte.
 */
export async function updatePreferences(
  user: User,
  patch: UserPreferences,
): Promise<ResolvedPreferences> {
  return db.transaction(async (trx) => {
    await trx
      .insertQuery()
      .table(UserPreference.table)
      .insert({ user_id: user.id, prefs: '{}' })
      .knexQuery.onConflict('user_id')
      .ignore()
    const row = await UserPreference.query({ client: trx })
      .where('userId', user.id)
      .forUpdate()
      .firstOrFail()
    const merged = safeMergePreferences(parseStored(row.prefs), patch)
    if (!merged.success) throw new ZodValidationException(merged.error.issues)
    if (Buffer.byteLength(JSON.stringify(merged.data)) > MAX_PREFERENCES_BYTES) {
      throw new PreferencesTooLargeException()
    }
    row.prefs = merged.data
    await row.useTransaction(trx).save()
    return resolvePreferences(merged.data)
  })
}
