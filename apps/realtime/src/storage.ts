import { type Connection, OutgoingMessage } from '@hocuspocus/server'
import { canEdit, type StorageStateMessage } from '@kaxolax/contracts'
import type { Logger } from 'pino'
import { contextOf, type ConnectionContext } from './access.js'
import type { DocumentStore } from './store.js'

/**
 * Limite de stockage du plan appliquée aux éditions temps réel. Le stockage d'un compte compte les
 * états Yjs de ses documents : quand celui du propriétaire du projet est plein (usage enregistré
 * ≥ limite de son plan, même règle que l'API), les connexions qui éditent passent en lecture
 * seule et leurs mises à jour sont refusées par Hocuspocus, jusqu'à ce que de la place soit
 * libérée (fichiers ou projets supprimés) ou le plan relevé. Le client reçoit un message
 * `plan.storage` à chaque changement d'état (l'usage `current`, celui de tout le compte, n'est
 * envoyé qu'au propriétaire).
 *
 * Les mises à jour refusées pendant que le stockage était plein n'existent que chez le client ;
 * celles qui suivent en dépendent (mises à jour Yjs incrémentales). Quand l'écriture est rendue,
 * le serveur envoie donc une étape 1 de synchronisation (son vecteur d'état) : le client répond
 * par une étape 2 avec tout ce qui manque au serveur, et rien de ce qu'il a écrit n'est perdu.
 *
 * L'usage est celui des états enregistrés : un document peut dépasser la limite d'au plus ce
 * qui est reçu entre deux enregistrements (10 s au plus) et deux lectures de l'usage.
 */

/** Types de messages y-protocols/sync qui portent des modifications. */
const SYNC_STEP_2 = 1
const SYNC_UPDATE = 2

interface CachedStorage {
  full: boolean
  ownerId: string | null
  message: StorageStateMessage | null
  checkedAt: number
}

export function createStorageGuard(options: {
  store: Pick<DocumentStore, 'ownerStorage'>
  logger: Logger
  /** Durée pendant laquelle l'état du stockage d'un projet est réutilisé (ms). */
  checkMs: number
  now?: () => number
}) {
  const { store, logger, checkMs } = options
  const now = options.now ?? Date.now
  const cache = new Map<string, CachedStorage>()
  const pending = new Map<string, Promise<CachedStorage>>()

  const read = async (projectId: string): Promise<CachedStorage> => {
    let entry: CachedStorage
    try {
      const storage = await store.ownerStorage(projectId)
      entry = storage
        ? {
            full: storage.used >= storage.limit,
            ownerId: storage.ownerId,
            message: {
              type: 'plan.storage',
              full: storage.used >= storage.limit,
              plan: storage.plan,
              max: storage.limit,
              current: storage.used,
            },
            checkedAt: now(),
          }
        : { full: false, ownerId: null, message: null, checkedAt: now() }
    } catch (error) {
      // Base indisponible : l'édition reste permise (comme pour le rôle), relu au prochain essai.
      logger.error({ err: error, projectId }, 'could not read owner storage')
      return { full: false, ownerId: null, message: null, checkedAt: 0 }
    }
    cache.set(projectId, entry)
    return entry
  }

  /** État du stockage du propriétaire du projet (cache de `checkMs`, une lecture à la fois). */
  const storageOf = (projectId: string): Promise<CachedStorage> => {
    const cached = cache.get(projectId)
    if (cached && now() - cached.checkedAt < checkMs) return Promise.resolve(cached)
    let reading = pending.get(projectId)
    if (!reading) {
      reading = read(projectId).finally(() => pending.delete(projectId))
      pending.set(projectId, reading)
    }
    return reading
  }

  /** Applique l'état du stockage à une connexion qui peut éditer ; envoie le changement. */
  const apply = (connection: Connection, context: ConnectionContext, entry: CachedStorage) => {
    if (entry.full === (context.storageFull === true)) return
    const wasFull = context.storageFull === true
    context.storageFull = entry.full
    connection.readOnly = entry.full || !canEdit(context.role)
    if (entry.message) {
      // Usage de tout le compte du propriétaire : jamais envoyé à un collaborateur.
      const { current, ...shared } = entry.message
      const message: StorageStateMessage =
        context.userId === entry.ownerId ? { ...shared, current } : shared
      connection.sendStateless(JSON.stringify(message))
    }
    if (wasFull && !entry.full) {
      // Écriture rendue : le client renvoie ce que le serveur a refusé (réponse à l'étape 1).
      connection.send(
        new OutgoingMessage(connection.messageAddress)
          .createSyncMessage()
          .writeFirstSyncStepFor(connection.document)
          .toUint8Array(),
      )
    }
    logger.info(
      { userId: context.userId, documentId: context.documentId, full: entry.full },
      entry.full ? 'edits refused: owner storage full' : 'edits allowed again: storage available',
    )
  }

  /**
   * Contrôle d'un message de synchronisation d'une connexion qui peut éditer (après le contrôle du
   * rôle) : lecture seule si le stockage du propriétaire est plein, écriture rendue sinon.
   */
  const beforeSync = async (connection: Connection, type: number): Promise<void> => {
    if (type !== SYNC_STEP_2 && type !== SYNC_UPDATE) return
    const context = contextOf(connection) as ConnectionContext | undefined
    if (typeof context?.projectId !== 'string' || !canEdit(context.role)) return
    apply(connection, context, await storageOf(context.projectId))
  }

  /** Après un enregistrement : l'usage du projet a changé, il sera relu à la prochaine édition. */
  const invalidate = (projectId: string): void => {
    cache.delete(projectId)
  }

  return { beforeSync, invalidate, storageOf }
}

export type StorageGuard = ReturnType<typeof createStorageGuard>
