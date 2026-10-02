import type { Connection, Document } from '@hocuspocus/server'
import { parsePresenceState, presenceUserFor } from '@kaxolax/contracts'
import type { Logger } from 'pino'
import { removeAwarenessStates } from 'y-protocols/awareness'
import { contextOf } from './access.js'

/**
 * clientIds Yjs annoncés par chaque connexion (clé : son contexte, propre à la connexion et au
 * document). Hocuspocus oublie les siens avant `onDisconnect` ; ceux-ci servent à retirer la
 * présence de la connexion fermée sur les autres instances (voir `departedClients`).
 */
const announcedClients = new WeakMap<object, Set<number>>()

/** clientIds Yjs rattachés par Hocuspocus à une connexion d'un document. */
function clientIdsOf(entry: { clients: unknown } | undefined): Set<number> {
  const ids = new Set<number>()
  if (entry?.clients instanceof Set) {
    for (const clientId of entry.clients as Set<unknown>)
      if (typeof clientId === 'number') ids.add(clientId)
  }
  return ids
}

/** clientIds tenus par les connexions d'un document, sauf `except`. */
function heldClientIds(document: Document, except?: Connection): Set<number> {
  const ids = new Set<number>()
  for (const [connection, entry] of document.connections) {
    if (connection !== except) for (const clientId of clientIdsOf(entry)) ids.add(clientId)
  }
  return ids
}

/**
 * clientIds en usage sur cette instance : ceux rattachés par Hocuspocus et ceux annoncés par les
 * connexions ouvertes. Hocuspocus ne rattache un clientId qu'à son ajout dans l'awareness ; un
 * client qui se reconnecte ici avec le même clientId, alors que son état relayé par une autre
 * instance est encore connu, n'est qu'une mise à jour et n'est donc pas rattaché.
 */
function liveClientIds(document: Document): Set<number> {
  const ids = heldClientIds(document)
  for (const connection of document.connections.keys()) {
    const context = contextOf(connection)
    const announced = context ? announcedClients.get(context) : undefined
    if (announced) for (const clientId of announced) ids.add(clientId)
  }
  return ids
}

/** Propriétaire (id d'utilisateur) d'un état d'awareness connu, ou null. */
function ownerOf(state: unknown): string | null {
  return parsePresenceState(state)?.user.id ?? null
}

/**
 * Awareness reçue d'une connexion, avant sa diffusion : l'identité (`user`) est imposée par le
 * serveur (id de l'utilisateur authentifié, nom et photo lus en base, couleur dérivée de l'id) ;
 * un client ne peut donc pas se faire passer pour un autre. Un état qui n'est pas un objet est
 * ignoré, comme un clientId Yjs qui appartient déjà à quelqu'un d'autre : autre connexion de cette
 * instance, ou état d'un autre utilisateur relayé par Redis depuis une autre instance (sinon un
 * membre pourrait remplacer, puis effacer partout, la présence d'un collaborateur). Un clientId
 * inconnu est accepté. Le reste de l'état (document ouvert, curseur) est validé par chaque client
 * à la réception (`parsePresenceState`).
 */
export function enforcePresenceIdentity(
  payload: {
    connection?: Connection
    document: Document
    states: Map<number, unknown>
  },
  logger: Logger,
): void {
  const { connection, document, states } = payload
  // Hors connexion cliente (relais Redis d'une autre instance, connexion directe) : l'état a déjà
  // été vérifié par l'instance qui l'a reçu.
  if (!connection) return
  const context = contextOf(connection)
  if (!context || typeof context.userId !== 'string') {
    states.clear()
    return
  }
  const user = presenceUserFor(context.userId, context.userName ?? null, context.avatarUrl ?? null)
  // clientIds Yjs déjà annoncés par les autres connexions de ce document.
  const foreign = heldClientIds(document, connection)
  const own = clientIdsOf(document.connections.get(connection))
  const known = document.awareness.getStates()
  let announced = announcedClients.get(context)
  for (const [clientId, state] of [...states]) {
    // État déjà connu (relayé par une autre instance), qui n'est pas celui de cette connexion :
    // seul le même utilisateur peut le reprendre (reconnexion après la perte d'une instance).
    const taken =
      foreign.has(clientId) ||
      (known.has(clientId) && !own.has(clientId) && ownerOf(known.get(clientId)) !== context.userId)
    if (taken || state === null || typeof state !== 'object' || Array.isArray(state)) {
      states.delete(clientId)
      logger.warn(
        { userId: context.userId, documentName: document.name, clientId },
        'awareness state ignored',
      )
      continue
    }
    states.set(clientId, { ...state, user })
    if (!announced) {
      announced = new Set()
      announcedClients.set(context, announced)
    }
    announced.add(clientId)
  }
}

/**
 * Connexion fermée : clientIds dont la présence doit disparaître (de cette instance et des
 * autres), sauf ceux repris entre-temps par une autre connexion du document. Les retire aussi de
 * l'awareness locale (un état repris sur un clientId connu n'est pas rattaché à la connexion par
 * Hocuspocus, qui ne l'efface donc pas lui-même).
 */
export function departedClients(context: object | undefined, document: Document): number[] {
  if (!context) return []
  const announced = announcedClients.get(context)
  announcedClients.delete(context)
  if (!announced) return []
  const stillUsed = liveClientIds(document)
  const departed = [...announced].filter((clientId) => !stillUsed.has(clientId))
  const present = departed.filter((clientId) => document.awareness.getStates().has(clientId))
  if (present.length > 0) removeAwarenessStates(document.awareness, present, { source: 'local' })
  return departed
}

/** Retire la présence d'une connexion fermée sur une autre instance (message du bus). */
export function removeRemoteClients(document: Document, clientIds: readonly number[]): void {
  const local = liveClientIds(document)
  // Un clientId tenu par une connexion de cette instance (reconnexion ici) reste.
  const removed = clientIds.filter(
    (clientId) => !local.has(clientId) && document.awareness.getStates().has(clientId),
  )
  if (removed.length > 0) removeAwarenessStates(document.awareness, removed, { source: 'redis' })
}
