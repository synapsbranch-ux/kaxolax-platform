import type { Connection, Hocuspocus } from '@hocuspocus/server'
import { parseUserChannelName } from '@kaxolax/collab'
import type { Logger } from 'pino'
import * as Y from 'yjs'
import { FORBIDDEN, MAX_REJECTED_UPDATES } from './access.js'
import type { DocumentStore } from './store.js'

/**
 * Canal temps réel d'un utilisateur (`user:{id}`, `@kaxolax/collab`) : ouvert par toutes les
 * pages connectées de l'application, il reçoit les événements diffusés à tous (bannière système)
 * sans dépendre d'un projet ouvert. Aucun contenu, aucune présence, rien n'est enregistré :
 * connexion en lecture seule, awareness ignorée. Le jeton (`scope: 'user'`) n'ouvre que le canal
 * de son titulaire ; un compte banni, supprimé ou dont les sessions ont été révoquées depuis
 * l'émission du jeton est refusé, puis fermé (route `/internal/users/:id/disconnect`, attache au
 * document et balayage périodique, comme les connexions des projets).
 */

/** Contexte d'une connexion au canal d'un utilisateur. */
export interface UserChannelContext {
  channel: 'user'
  userId: string
  /** `iat` du jeton (secondes) : la révocation des sessions est revérifiée à chaque relecture. */
  issuedAt: number
  /** Mises à jour Yjs refusées (le canal n'a pas de contenu). */
  rejectedUpdates: number
}

/** Types de messages y-protocols/sync qui portent des modifications. */
const SYNC_STEP_2 = 1
const SYNC_UPDATE = 2

/** Contexte de canal utilisateur d'une connexion, sinon null (connexion d'un projet). */
export function userChannelContextOf(connection: Connection): UserChannelContext | null {
  const context = connection.context as Partial<UserChannelContext> | undefined
  return context?.channel === 'user' && typeof context.userId === 'string'
    ? (context as UserChannelContext)
    : null
}

export function createUserChannels(options: {
  store: Pick<DocumentStore, 'accountActive'>
  logger: Logger
}) {
  const { store, logger } = options

  /** Connexions de cette instance aux canaux des utilisateurs. */
  function* connectionsOf(instance: Hocuspocus) {
    for (const [name, document] of instance.documents) {
      if (!parseUserChannelName(name)) continue
      for (const connection of document.getConnections()) {
        const context = userChannelContextOf(connection)
        if (context) yield { connection, context }
      }
    }
  }

  const close = (connection: Connection, context: UserChannelContext, reason: string) => {
    connection.readOnly = true
    connection.close(FORBIDDEN)
    logger.info({ userId: context.userId, reason }, 'user channel closed')
  }

  /**
   * Relit l'état du compte d'une connexion et la ferme s'il n'a plus accès. Base indisponible :
   * la connexion reste (relue au prochain balayage).
   */
  const recheck = async (connection: Connection): Promise<void> => {
    const context = userChannelContextOf(connection)
    if (!context) return
    let active: boolean
    try {
      active = await store.accountActive(context.userId, context.issuedAt)
    } catch (error) {
      logger.error({ err: error, userId: context.userId }, 'could not recheck user channel')
      return
    }
    if (!active) close(connection, context, 'account no longer active')
  }

  /** Relecture périodique de toutes les connexions de cette instance (filet, voir `access.ts`). */
  const sweep = async (instance: Hocuspocus): Promise<number> => {
    let closed = 0
    const accounts = new Map<string, boolean>()
    for (const { connection, context } of [...connectionsOf(instance)]) {
      const key = `${context.userId}:${String(context.issuedAt)}`
      let active = accounts.get(key)
      if (active === undefined) {
        active = await store.accountActive(context.userId, context.issuedAt)
        accounts.set(key, active)
      }
      if (!active) {
        close(connection, context, 'account no longer active')
        closed++
      }
    }
    return closed
  }

  /**
   * Message de synchronisation reçu sur un canal : Hocuspocus refuse toute modification (lecture
   * seule) ; au-delà de `MAX_REJECTED_UPDATES` refus, la connexion est fermée.
   */
  const beforeSync = (
    connection: Connection,
    document: Y.Doc,
    type: number,
    payload: Uint8Array,
  ): void => {
    if (type !== SYNC_STEP_2 && type !== SYNC_UPDATE) return
    const context = userChannelContextOf(connection)
    if (!context) return
    // Une étape 2 sans rien de nouveau (client à jour) est acceptée par Hocuspocus.
    if (type === SYNC_STEP_2 && Y.snapshotContainsUpdate(Y.snapshot(document), payload)) return
    context.rejectedUpdates++
    logger.warn(
      { userId: context.userId, rejected: context.rejectedUpdates },
      'update rejected on a user channel',
    )
    if (
      context.rejectedUpdates >= MAX_REJECTED_UPDATES &&
      connection.document.hasConnection(connection)
    ) {
      close(connection, context, 'repeated updates')
    }
  }

  /** Ferme les canaux d'un compte (banni, supprimé, sessions révoquées) ; renvoie leur nombre. */
  const disconnectUser = (instance: Hocuspocus, userId: string): number => {
    let closed = 0
    for (const { connection, context } of [...connectionsOf(instance)]) {
      if (context.userId !== userId) continue
      close(connection, context, 'disconnected by the API')
      closed++
    }
    return closed
  }

  /** Envoie un message sans état à chaque canal ouvert sur cette instance ; renvoie le nombre. */
  const deliverToAll = (instance: Hocuspocus, payload: string): number => {
    let delivered = 0
    for (const { connection } of connectionsOf(instance)) {
      connection.sendStateless(payload)
      delivered++
    }
    return delivered
  }

  return { beforeSync, connectionsOf, deliverToAll, disconnectUser, recheck, sweep }
}

export type UserChannels = ReturnType<typeof createUserChannels>
