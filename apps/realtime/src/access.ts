import type { Connection, Hocuspocus } from '@hocuspocus/server'
import {
  canEdit,
  type MemberChangedResponse,
  type ProjectRole,
  REALTIME_FORBIDDEN_CLOSE_CODE,
  type RoleChangedMessage,
} from '@kaxolax/contracts'
import type { Logger } from 'pino'
import * as Y from 'yjs'
import type { DocumentStore } from './store.js'

/**
 * Application des permissions aux connexions ouvertes : rôle relu en base, lecture seule selon la
 * matrice de `@kaxolax/contracts`, rejet des mises à jour d'un lecteur, fermeture d'un membre
 * retiré. Tout passe par ce module, pour que l'extension Redis (tâche 5) n'ait qu'à brancher un
 * `MemberChangeFanout` qui relaie les changements aux autres instances.
 */

/** Contexte d'une connexion authentifiée (objet partagé par tous les hooks de la connexion). */
export interface ConnectionContext {
  userId: string
  /**
   * Nom complet et photo de profil, lus en base à l'authentification : imposés dans l'awareness de
   * la connexion (jamais l'email).
   */
  userName: string | null
  avatarUrl: string | null
  projectId: string
  /** Document texte ouvert ; null pour le document meta du projet. */
  documentId: string | null
  /** Document meta : toujours en lecture seule, quel que soit le rôle (awareness seulement). */
  meta: boolean
  /** Rôle appliqué, mis à jour à chaque changement notifié ou relu. */
  role: ProjectRole
  /** `iat` du jeton (secondes) : la révocation des sessions est revérifiée à chaque relecture. */
  issuedAt: number
  /** Dernière lecture du rôle en base (ms depuis l'époque Unix). */
  roleCheckedAt: number
  /** Mises à jour refusées à cette connexion en lecture seule. */
  rejectedUpdates: number
  /**
   * Stockage du propriétaire plein (`./storage.ts`) : lecture seule tant qu'il le reste, quel que
   * soit le rôle ; ces refus ne comptent pas dans `rejectedUpdates`.
   */
  storageFull?: boolean
}

/** Fermeture imposée (membre retiré, compte banni ou supprimé) : code Forbidden de Hocuspocus. */
export const FORBIDDEN = { code: REALTIME_FORBIDDEN_CLOSE_CODE, reason: 'Forbidden' }

/** Au-delà de ce nombre de mises à jour refusées, une connexion en lecture seule est fermée. */
export const MAX_REJECTED_UPDATES = 5

/** Types de messages y-protocols/sync qui portent des modifications. */
const SYNC_STEP_2 = 1
const SYNC_UPDATE = 2

/** Changement de rôle ou retrait d'un membre, à appliquer à ses connexions. */
export interface MemberChange {
  projectId: string
  userId: string
}

/**
 * Diffusion des changements de membres entre instances : `publish` envoie aux autres instances,
 * qui appellent `applyMemberChange` dans leur abonnement. Sans Redis, rien à relayer
 * (`singleInstanceFanout`) ; avec `REDIS_URL`, implémentation pub/sub (`cluster.ts`).
 */
export interface MemberChangeFanout {
  publish(change: MemberChange): Promise<void>
  subscribe(listener: (change: MemberChange) => Promise<void>): void
}

export const singleInstanceFanout: MemberChangeFanout = {
  publish: () => Promise.resolve(),
  subscribe: () => undefined,
}

export function contextOf(connection: Connection): Partial<ConnectionContext> | undefined {
  return connection.context as Partial<ConnectionContext> | undefined
}

function isComplete(context: Partial<ConnectionContext> | undefined): context is ConnectionContext {
  return typeof context?.userId === 'string' && typeof context.projectId === 'string'
}

export function createAccessControl(options: {
  store: DocumentStore
  logger: Logger
  /** Délai au-delà duquel une mise à jour d'un rédacteur fait relire son rôle en base. */
  roleRecheckMs: number
}) {
  const { store, logger, roleRecheckMs } = options

  /**
   * Numéro de lecture du rôle, croissant, pris AVANT la requête en base. Une lecture lancée avant
   * un changement peut revenir après la lecture qui l'a vu : seule une lecture plus récente que la
   * dernière appliquée à la connexion compte, sinon un membre rétrogradé retrouverait l'écriture.
   */
  let readSequence = 0
  const appliedRead = new WeakMap<Connection, number>()
  const startRead = (): number => ++readSequence

  /** Lecture du rôle en base, avec son numéro (pris avant la requête). */
  const readRole = async (context: ConnectionContext) => {
    const read = startRead()
    const role = await store.memberRole(context.projectId, context.userId, context.issuedAt)
    return { read, role }
  }

  /** Balayage en cours : un balayage n'est pas lancé tant que le précédent n'est pas fini. */
  let sweeping = false

  /** Connexions de cette instance, avec leur contexte complet. */
  function* connectionsOf(instance: Hocuspocus) {
    for (const document of instance.documents.values()) {
      for (const connection of document.getConnections()) {
        const context = contextOf(connection)
        if (isComplete(context)) yield { connection, context }
      }
    }
  }

  /**
   * Applique un rôle relu en base : fermeture si la personne n'a plus accès (null), sinon lecture
   * seule selon la matrice et message sans état à l'éditeur si le rôle change. Renvoie l'effet.
   * `read` est le numéro de la lecture (`startRead`, pris avant la requête) : une lecture plus
   * ancienne que la dernière appliquée à cette connexion est périmée et ignorée ('stale').
   */
  const applyRole = (
    connection: Connection,
    context: ConnectionContext,
    role: ProjectRole | null,
    read: number,
  ): 'closed' | 'updated' | 'unchanged' | 'stale' => {
    if (read <= (appliedRead.get(connection) ?? 0)) return 'stale'
    appliedRead.set(connection, read)
    context.roleCheckedAt = Date.now()
    if (role === null) {
      // Lecture seule d'abord : une mise à jour encore en file ne peut plus s'appliquer.
      connection.readOnly = true
      connection.close(FORBIDDEN)
      logger.info(
        { userId: context.userId, documentId: context.documentId },
        'connection closed: no longer a member',
      )
      return 'closed'
    }
    // Le document meta reste en lecture seule ; le message décrit les documents du projet.
    const readOnly = context.meta || !canEdit(role) || context.storageFull === true
    if (role === context.role && connection.readOnly === readOnly) return 'unchanged'
    context.role = role
    connection.readOnly = readOnly
    context.rejectedUpdates = 0
    const message: RoleChangedMessage = {
      type: 'member.role-changed',
      role,
      readOnly: !canEdit(role),
    }
    connection.sendStateless(JSON.stringify(message))
    logger.info(
      { userId: context.userId, documentId: context.documentId, role, readOnly },
      'connection role changed',
    )
    return 'updated'
  }

  /**
   * Relit le rôle d'un membre et l'applique à toutes ses connexions sur le projet, dans cette
   * instance (route interne appelée par l'API, puis relayée aux autres instances).
   */
  const applyMemberChange = async (
    instance: Hocuspocus,
    change: MemberChange,
  ): Promise<MemberChangedResponse> => {
    const result: MemberChangedResponse = { closed: 0, updated: 0 }
    const targets = [...connectionsOf(instance)].filter(
      ({ context }) => context.projectId === change.projectId && context.userId === change.userId,
    )
    // Une lecture par date d'émission de jeton (la révocation des sessions en dépend). Une lecture
    // concurrente plus récente (balayage, mise à jour) déjà appliquée prime sur celle-ci.
    const roles = new Map<number, { read: number; role: ProjectRole | null }>()
    for (const { connection, context } of targets) {
      let entry = roles.get(context.issuedAt)
      if (!entry) {
        entry = await readRole(context)
        roles.set(context.issuedAt, entry)
      }
      const effect = applyRole(connection, context, entry.role, entry.read)
      if (effect === 'closed' || effect === 'updated') result[effect]++
    }
    return result
  }

  /** Revérification à l'attache au document (rôle changé ou retrait pendant le chargement). */
  const recheck = async (connection: Connection): Promise<void> => {
    const context = contextOf(connection)
    if (!isComplete(context)) return
    const read = startRead()
    let role: ProjectRole | null = null
    try {
      role = await store.memberRole(context.projectId, context.userId, context.issuedAt)
    } catch (error) {
      logger.error({ err: error, userId: context.userId }, 'could not recheck connection')
    }
    applyRole(connection, context, role, read)
  }

  /**
   * Contrôle de chaque message de synchronisation, avant que Hocuspocus ne l'applique :
   * - rédacteur : rôle relu en base si la dernière lecture date de plus de `roleRecheckMs` (filet
   *   si une notification de l'API s'est perdue) ; un rôle devenu lecteur rend la connexion en
   *   lecture seule avant l'application, la mise à jour est donc rejetée ;
   * - lecture seule : Hocuspocus rejette la mise à jour (statut de synchronisation faux) ; elle est
   *   journalisée et la connexion fermée au-delà de `MAX_REJECTED_UPDATES`.
   */
  const beforeSync = async (
    connection: Connection,
    document: Y.Doc,
    type: number,
    payload: Uint8Array,
  ): Promise<void> => {
    if (type !== SYNC_STEP_2 && type !== SYNC_UPDATE) return
    const context = contextOf(connection)
    if (!isComplete(context)) return
    if (!connection.readOnly && Date.now() - context.roleCheckedAt >= roleRecheckMs) {
      let entry: { read: number; role: ProjectRole | null }
      try {
        entry = await readRole(context)
      } catch (error) {
        // Base indisponible : le rôle connu reste appliqué, relu à la prochaine mise à jour.
        logger.error({ err: error, userId: context.userId }, 'could not recheck role')
        return
      }
      // Lecture périmée (un changement plus récent est déjà appliqué) : ignorée, et l'état
      // courant de la connexion (éventuellement lecture seule) décide ci-dessous.
      applyRole(connection, context, entry.role, entry.read)
    }
    if (!connection.readOnly) return
    // Lecture seule due au stockage plein (rôle qui édite) : refus normal, sans fermeture.
    if (context.storageFull === true && canEdit(context.role)) return
    // Une étape 2 sans rien de nouveau (client lecteur à jour) est acceptée par Hocuspocus.
    if (type === SYNC_STEP_2 && Y.snapshotContainsUpdate(Y.snapshot(document), payload)) return
    context.rejectedUpdates++
    logger.warn(
      {
        userId: context.userId,
        documentId: context.documentId,
        role: context.role,
        rejected: context.rejectedUpdates,
      },
      'update rejected on a read-only connection',
    )
    if (
      context.rejectedUpdates >= MAX_REJECTED_UPDATES &&
      connection.document.hasConnection(connection)
    ) {
      connection.close(FORBIDDEN)
      logger.warn(
        { userId: context.userId, documentId: context.documentId },
        'read-only connection closed after repeated updates',
      )
    }
  }

  /**
   * Relit périodiquement le rôle de toutes les connexions de cette instance : filet pour un
   * lecteur (qui n'envoie pas de mise à jour) dont la notification de retrait se serait perdue.
   * Un balayage demandé pendant qu'un autre tourne (base lente) ne fait rien. Une valeur mise en
   * cache pour une personne garde son numéro de lecture : un changement appliqué entre-temps à sa
   * deuxième connexion n'est pas écrasé.
   */
  const sweep = async (instance: Hocuspocus): Promise<MemberChangedResponse> => {
    const result: MemberChangedResponse = { closed: 0, updated: 0 }
    if (sweeping) return result
    sweeping = true
    try {
      const roles = new Map<string, { read: number; role: ProjectRole | null }>()
      for (const { connection, context } of [...connectionsOf(instance)]) {
        const key = `${context.projectId}:${context.userId}:${String(context.issuedAt)}`
        let entry = roles.get(key)
        if (!entry) {
          entry = await readRole(context)
          roles.set(key, entry)
        }
        const effect = applyRole(connection, context, entry.role, entry.read)
        if (effect === 'closed' || effect === 'updated') result[effect]++
      }
    } finally {
      sweeping = false
    }
    return result
  }

  return { applyMemberChange, applyRole, recheck, beforeSync, sweep, connectionsOf }
}

export type AccessControl = ReturnType<typeof createAccessControl>
