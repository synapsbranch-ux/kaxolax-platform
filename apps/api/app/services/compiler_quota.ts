import { Exception } from '@adonisjs/core/exceptions'
import db from '@adonisjs/lucid/services/db'
import compileConfig from '#config/compile'

/** L'utilisateur a déjà réveillé trop de compilateurs (projets distincts) dans la fenêtre. */
export class TooManyCompilersException extends Exception {
  static override status = 429
  static override code = 'E_TOO_MANY_COMPILERS'
  static override message = 'Too many compilers started recently. Try again in a few minutes.'
}

/**
 * Plafond par utilisateur des compilateurs Cloudflare réveillés (`compiler/warm`, compilation
 * asynchrone) : au plus `maxCompilersPerUser` projets distincts sur la durée de mise en sommeil
 * d'un conteneur. Sans lui, un seul compte garderait éveillés tous les conteneurs du compte
 * Cloudflare (`max_instances`). Réutiliser un projet déjà compté ne coûte rien. Un verrou
 * consultatif par utilisateur rend la vérification et l'enregistrement atomiques.
 *
 * `warm` (réveil anticipé, simple consultation) ne prend jamais le dernier emplacement libre :
 * il le laisse à une vraie compilation et renvoie faux au lieu de refuser. Une compilation
 * (`warm` absent) lève 429 `E_TOO_MANY_COMPILERS` au-delà du plafond.
 */
export async function reserveCompiler(
  userId: string,
  projectId: string,
  { warm = false }: { warm?: boolean } = {},
): Promise<boolean> {
  return db.transaction(async (trx) => {
    await trx.rawQuery('SELECT pg_advisory_xact_lock(hashtextextended(?, 0))', [
      `compiler-quota:${userId}`,
    ])
    const window = `interval '1 millisecond' * CAST(? AS integer)`
    await trx.rawQuery(
      `DELETE FROM compiler_activations WHERE user_id = ? AND last_activity_at < now() - ${window}`,
      [userId, compileConfig.compilerWindowMs],
    )
    const others = await trx.rawQuery<{ rows: { count: string }[] }>(
      'SELECT count(*) AS count FROM compiler_activations WHERE user_id = ? AND project_id <> ?',
      [userId, projectId],
    )
    const counted = await trx.rawQuery<{ rows: unknown[] }>(
      'SELECT 1 FROM compiler_activations WHERE user_id = ? AND project_id = ?',
      [userId, projectId],
    )
    const used = Number(others.rows[0]?.count ?? 0)
    // Projet déjà compté : il ne prend pas d'emplacement supplémentaire.
    const limit = compileConfig.maxCompilersPerUser - (warm && counted.rows.length === 0 ? 1 : 0)
    if (used >= limit) {
      if (warm) return false
      throw new TooManyCompilersException()
    }
    await trx.rawQuery(
      `INSERT INTO compiler_activations (user_id, project_id, last_activity_at)
       VALUES (?, ?, now())
       ON CONFLICT (user_id, project_id) DO UPDATE SET last_activity_at = now()`,
      [userId, projectId],
    )
    return true
  })
}
