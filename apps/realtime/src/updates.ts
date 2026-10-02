import type { Logger } from 'pino'
import * as Y from 'yjs'
import type { DocumentStore } from './store.js'

/**
 * Journal de l'origine des mises à jour Yjs (historique, tâche 8). Chaque instance journalise les
 * mises à jour reçues de SES connexions (et des restaurations faites chez elle) : une mise à jour
 * relayée par Redis depuis une autre instance y a déjà été journalisée, elle est ignorée. Chaque
 * mise à jour est donc écrite une seule fois, quel que soit le nombre d'instances.
 *
 * Les mises à jour consécutives d'un même auteur sur un document sont fusionnées (Y.mergeUpdates)
 * et écrites par lots toutes les `flushMs` millisecondes, dans l'ordre d'arrivée : l'attribution
 * reste exacte (une ligne n'a qu'un auteur). Avec plusieurs instances, l'ordre des lignes peut
 * différer de l'ordre causal (chaque instance écrit ses lots à son rythme) : le rejeu
 * (`replayWithAttribution`) attribue chaque élément par son identifiant Yjs, pas par l'ordre des
 * lignes. Une écriture perdue (base indisponible, arrêt brutal)
 * est rattrapée à la version suivante depuis l'état enregistré du document, sans auteur.
 */

interface Pending {
  userId: string | null
  updates: Uint8Array[]
}

interface DocumentQueue {
  projectId: string
  documentId: string
  pending: Pending[]
  timer: NodeJS.Timeout | undefined
  /** Écriture en cours : les lots d'un document sont écrits l'un après l'autre. */
  writing: Promise<void>
}

export class UpdateRecorder {
  private readonly queues = new Map<string, DocumentQueue>()

  constructor(
    private readonly store: DocumentStore,
    private readonly logger: Logger,
    private readonly flushMs: number,
  ) {}

  /** Journalise une mise à jour appliquée au document (écriture différée). */
  record(projectId: string, documentId: string, userId: string | null, update: Uint8Array): void {
    let queue = this.queues.get(documentId)
    if (!queue) {
      queue = { projectId, documentId, pending: [], timer: undefined, writing: Promise.resolve() }
      this.queues.set(documentId, queue)
    }
    const last = queue.pending.at(-1)
    if (last?.userId === userId) last.updates.push(update)
    else queue.pending.push({ userId, updates: [update] })
    if (!queue.timer) {
      const scheduled = queue
      queue.timer = setTimeout(() => {
        void this.flushQueue(scheduled)
      }, this.flushMs)
      queue.timer.unref()
    }
  }

  /** Mises à jour en attente (tous documents). */
  get pendingCount(): number {
    let count = 0
    for (const queue of this.queues.values()) {
      for (const entry of queue.pending) count += entry.updates.length
    }
    return count
  }

  /**
   * Écrit tout de suite ce qui attend pour un projet (ou pour tous si `projectId` est absent) et
   * attend la fin des écritures en cours. Renvoie le nombre de lignes écrites.
   */
  async flush(projectId?: string): Promise<number> {
    const queues = [...this.queues.values()].filter(
      (queue) => projectId === undefined || queue.projectId === projectId,
    )
    const written = await Promise.all(queues.map((queue) => this.flushQueue(queue)))
    return written.reduce((sum, count) => sum + count, 0)
  }

  private flushQueue(queue: DocumentQueue): Promise<number> {
    clearTimeout(queue.timer)
    queue.timer = undefined
    const batch = queue.pending.splice(0)
    const rows = batch.map((entry) => ({
      projectId: queue.projectId,
      documentId: queue.documentId,
      userId: entry.userId,
      update: Y.mergeUpdates(entry.updates),
    }))
    const write = queue.writing.then(async () => {
      if (rows.length === 0) return 0
      try {
        await this.store.insertUpdates(rows)
        return rows.length
      } catch (error) {
        // Document supprimé entre-temps (clé étrangère), base indisponible : rattrapé plus tard.
        this.logger.warn(
          { err: error, documentId: queue.documentId, rows: rows.length },
          'could not record document updates',
        )
        return 0
      }
    })
    const chained = write.then(() => undefined)
    queue.writing = chained
    // File vide et sans écriture plus récente : retirée (un document fermé ne reste pas en mémoire).
    void chained.then(() => {
      if (
        queue.writing === chained &&
        queue.pending.length === 0 &&
        !queue.timer &&
        this.queues.get(queue.documentId) === queue
      ) {
        this.queues.delete(queue.documentId)
      }
    })
    return write
  }
}
