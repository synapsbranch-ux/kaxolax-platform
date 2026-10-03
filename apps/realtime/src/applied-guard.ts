import type { Logger } from 'pino'
import { APPLIED_SUGGESTIONS_FIELD } from '@kaxolax/collab'
import { isTransactionOrigin } from '@hocuspocus/server'
import type * as Y from 'yjs'

/**
 * Garde de la map `APPLIED_SUGGESTIONS_FIELD` (suggestions appliquées → décideur), que l'API
 * prend pour vraie : seul le service y écrit (connexion directe de `applySuggestions`). Toute
 * modification venue d'un client WebSocket (origine `connection`) est annulée aussitôt, dans une
 * transaction du serveur relayée à tous : clé ajoutée retirée, valeur remplacée ou supprimée
 * rétablie. Une mise à jour relayée par Redis (`redis`) est laissée à l'instance qui l'a reçue,
 * qui l'annule de même.
 */
export function guardAppliedSuggestions(document: Y.Doc, logger: Logger): void {
  const applied = document.getMap<string>(APPLIED_SUGGESTIONS_FIELD)
  applied.observe((event, transaction) => {
    const origin: unknown = transaction.origin
    if (!isTransactionOrigin(origin) || origin.source !== 'connection') return
    const changes = [...event.changes.keys]
    if (changes.length === 0) return
    const context = origin.connection.context as { userId?: unknown } | undefined
    logger.warn(
      {
        userId: typeof context?.userId === 'string' ? context.userId : null,
        keys: changes.length,
      },
      'client change to applied suggestions reverted',
    )
    // Transaction ouverte depuis l'observateur : Yjs l'exécute juste après celle du client.
    document.transact(
      () => {
        for (const [key, change] of changes) {
          const previous: unknown = change.oldValue
          if (change.action === 'add' || typeof previous !== 'string') applied.delete(key)
          else applied.set(key, previous)
        }
      },
      { source: 'local' },
    )
  })
}
