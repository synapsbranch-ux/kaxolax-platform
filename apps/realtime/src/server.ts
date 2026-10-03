import { createHash, randomUUID, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { Database } from '@hocuspocus/extension-database'
import { Redis as RedisExtension } from '@hocuspocus/extension-redis'
import { type Extension, type Hocuspocus, isTransactionOrigin, Server } from '@hocuspocus/server'
import {
  APPLIED_SUGGESTIONS_FIELD,
  applySuggestion,
  documentName,
  parseDocumentName,
  parseMetaDocumentName,
  parseRealtimeDocumentName,
  replaceTextMinimally,
  TEXT_FIELD,
  textOf,
} from '@kaxolax/collab'
import { verifyRealtimeToken, verifyUserRealtimeToken } from '@kaxolax/collab/token'
import {
  type AppliedSuggestionsRequest,
  appliedSuggestionsRequestSchema,
  type AppliedSuggestionsResponse,
  type ApplySuggestionsRequest,
  applySuggestionsRequestSchema,
  type ApplySuggestionsResponse,
  canDecideSuggestion,
  canEdit,
  type CloseDocumentResponse,
  type DisconnectUserResponse,
  type FlushUpdatesResponse,
  INTERNAL_TOKEN_HEADER,
  MAX_PROJECT_EVENT_BYTES,
  type ProjectEventMessage,
  projectEventMessage,
  type ProjectSnapshot,
  publishBroadcastEventRequestSchema,
  type PublishEventResponse,
  publishProjectEventRequestSchema,
  type ReplaceDocumentRequest,
  replaceDocumentRequestSchema,
  type ReplaceDocumentResponse,
} from '@kaxolax/contracts'
import type { Logger } from 'pino'
import type * as Y from 'yjs'
import { type ConnectionContext, createAccessControl, FORBIDDEN } from './access.js'
import { guardAppliedSuggestions } from './applied-guard.js'
import { decodeDocumentState, encodeDocumentState, waitForStates } from './catch-up.js'
import {
  type ClusterBus,
  type ClusterMessage,
  memberChangeFanout,
  RedisClusterBus,
  redisConnectionOptions,
  singleInstanceBus,
} from './cluster.js'
import type { RealtimeConfig } from './config.js'
import { departedClients, enforcePresenceIdentity, removeRemoteClients } from './presence.js'
import { createStorageGuard } from './storage.js'
import type { DocumentStore } from './store.js'
import { UpdateRecorder } from './updates.js'
import {
  createUserChannels,
  type UserChannelContext,
  userChannelContextOf,
} from './user-channel.js'

export type { ConnectionContext } from './access.js'
export type { UserChannelContext } from './user-channel.js'

type ServerOptions = Pick<
  RealtimeConfig,
  | 'HOST'
  | 'PORT'
  | 'REALTIME_TOKEN_SECRET'
  | 'INTERNAL_TOKEN'
  | 'STORE_DEBOUNCE_MS'
  | 'STORE_MAX_DEBOUNCE_MS'
> &
  Partial<
    Pick<
      RealtimeConfig,
      | 'ROLE_RECHECK_MS'
      | 'ROLE_SWEEP_MS'
      | 'STORAGE_CHECK_MS'
      | 'REDIS_URL'
      | 'REDIS_PREFIX'
      | 'HISTORY_FLUSH_MS'
    >
  >

/** Un message Yjs peut contenir tout l'état d'un document de 2 Mio, historique compris. */
const MAX_MESSAGE_BYTES = 16 * 1024 * 1024

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
const SNAPSHOT_ROUTE = new RegExp(`^/internal/projects/(${UUID})/snapshot$`)
const CLOSE_ROUTE = new RegExp(`^/internal/documents/(${UUID})/close$`)
const DISCONNECT_USER_ROUTE = new RegExp(`^/internal/users/(${UUID})/disconnect$`)
const MEMBER_CHANGED_ROUTE = new RegExp(`^/internal/projects/(${UUID})/members/(${UUID})/changed$`)
const PROJECT_EVENTS_ROUTE = new RegExp(`^/internal/projects/(${UUID})/events$`)
const FLUSH_UPDATES_ROUTE = new RegExp(`^/internal/projects/(${UUID})/updates/flush$`)
const REPLACE_ROUTE = new RegExp(`^/internal/projects/(${UUID})/documents/(${UUID})/replace$`)
const APPLY_SUGGESTIONS_ROUTE = new RegExp(
  `^/internal/projects/(${UUID})/documents/(${UUID})/suggestions/apply$`,
)
const APPLIED_SUGGESTIONS_ROUTE = new RegExp(
  `^/internal/projects/(${UUID})/documents/(${UUID})/suggestions/applied$`,
)

/**
 * Restauration avec plusieurs instances : le document chargé ici peut ne pas encore avoir reçu
 * les dernières modifications d'une autre instance (extension Redis). Le texte est revérifié après
 * ce délai et remplacé de nouveau s'il diffère, au plus `REPLACE_ATTEMPTS` fois.
 */
const REPLACE_SETTLE_MS = 150
const REPLACE_ATTEMPTS = 3
/** Attente maximale des réponses des autres instances à une demande d'écriture du journal. */
const FLUSH_ACK_TIMEOUT_MS = 2_000

/**
 * Instantané avec plusieurs instances : attente des états des documents ouverts ailleurs, puis
 * de leur arrivée par l'extension Redis (même principe que la restauration, avec une condition
 * exacte : l'état de chaque autre instance est contenu dans la copie locale).
 */
const SNAPSHOT_PEERS_TIMEOUT_MS = 1_000
const SNAPSHOT_SYNC_TIMEOUT_MS = 3_000

/**
 * Taille maximale du corps d'une restauration de texte (document de 2 Mio, échappé en JSON) ou
 * d'un lot de suggestions acceptées (50 au plus, deux textes de 20 000 caractères chacune).
 */
const MAX_REPLACE_BYTES = 8 * 1024 * 1024
const BROADCAST_EVENTS_ROUTE = '/internal/events'

/**
 * Corps maximal d'une requête interne (un événement, jamais un document) : l'API retire d'un
 * événement de compilation le résultat qui le dépasserait (`fitProjectEvent`).
 */
const MAX_REQUEST_BYTES = MAX_PROJECT_EVENT_BYTES

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

/** Comparaison à temps constant, quelle que soit la longueur de la valeur reçue. */
function sameSecret(received: string | string[] | undefined, expected: string): boolean {
  if (typeof received !== 'string') return false
  const digest = (value: string) => createHash('sha256').update(value).digest()
  return timingSafeEqual(digest(received), digest(expected))
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
  })
  response.end(payload)
}

/** Corps JSON trop gros ou mal formé d'une requête interne. */
class BadRequest extends Error {}

async function readJson(
  request: IncomingMessage,
  maxBytes: number = MAX_REQUEST_BYTES,
): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request as AsyncIterable<unknown>) {
    const buffer = Buffer.isBuffer(chunk)
      ? chunk
      : Buffer.from(typeof chunk === 'string' ? chunk : '')
    size += buffer.length
    if (size > maxBytes) throw new BadRequest('request body too large')
    chunks.push(buffer)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new BadRequest('invalid JSON body')
  }
}

/** Demande en attente des réponses des autres instances (`askPeers`). */
interface PeerRequest {
  replies: ClusterMessage[]
  expected: number
  done: () => void
}

/** Refus d'authentification : le client reçoit un motif générique, le journal garde le détail. */
class AccessDenied extends Error {
  constructor(readonly detail: string) {
    super('permission-denied')
  }
}

/** Dépendances remplaçables (tests) : bus entre instances, par défaut tiré de `REDIS_URL`. */
export interface RealtimeDependencies {
  bus?: ClusterBus
}

/**
 * Service temps réel. Avec `REDIS_URL`, plusieurs instances partagent les documents, l'awareness
 * et les messages sans état (extension Redis de Hocuspocus) ; un bus Redis pub/sub (`cluster.ts`)
 * relaie les changements de membres, les fermetures de connexions et les événements du projet.
 */
export function createRealtimeServer(
  options: ServerOptions,
  store: DocumentStore,
  logger: Logger,
  dependencies: RealtimeDependencies = {},
) {
  const redisPrefix = options.REDIS_PREFIX ?? 'kaxolax-realtime'
  const bus: ClusterBus =
    dependencies.bus ??
    (options.REDIS_URL
      ? new RedisClusterBus(options.REDIS_URL, `${redisPrefix}:cluster`, logger)
      : singleInstanceBus)
  const fanout = memberChangeFanout(bus)
  const redisExtensions: Extension[] = options.REDIS_URL
    ? [
        new RedisExtension({
          ...redisConnectionOptions(options.REDIS_URL),
          prefix: `${redisPrefix}:docs`,
        }),
      ]
    : []
  const access = createAccessControl({
    store,
    logger,
    roleRecheckMs: options.ROLE_RECHECK_MS ?? 5_000,
  })
  const storage = createStorageGuard({
    store,
    logger,
    checkMs: options.STORAGE_CHECK_MS ?? 10_000,
  })
  const userChannels = createUserChannels({ store, logger })
  const sweepMs = options.ROLE_SWEEP_MS ?? 30_000
  let sweepTimer: NodeJS.Timeout | undefined
  const recorder = new UpdateRecorder(store, logger, options.HISTORY_FLUSH_MS ?? 100)

  /** Demandes envoyées aux autres instances : réponses reçues, nombre attendu. */
  const peerRequests = new Map<string, PeerRequest>()

  /**
   * Envoie une demande aux autres instances et attend leurs réponses (même `requestId`), au plus
   * `timeoutMs` en tout, envoi compris : un Redis indisponible (commande en file d'attente hors
   * ligne, puis rejetée) ne bloque ni ne fait échouer l'appelant. Renvoie les réponses reçues et
   * le nombre d'instances qui devaient répondre, null s'il est inconnu (envoi échoué ou trop lent).
   */
  const askPeers = async (
    request: (requestId: string) => ClusterMessage,
    timeoutMs: number,
  ): Promise<{ replies: ClusterMessage[]; peers: number | null }> => {
    const requestId = randomUUID()
    const message = request(requestId)
    let timer: NodeJS.Timeout | undefined
    let peers: number | null = null
    // Inscrite avant l'envoi : une réponse peut arriver avant le nombre de destinataires.
    const pending: PeerRequest = {
      replies: [],
      expected: Number.POSITIVE_INFINITY,
      done: () => undefined,
    }
    const answered = new Promise<void>((resolve) => {
      pending.done = resolve
      timer = setTimeout(resolve, timeoutMs)
    })
    peerRequests.set(requestId, pending)
    // Envoi non attendu directement : le délai borne aussi la publication.
    bus.publishCounted(message).then(
      (count) => {
        peers = count
        pending.expected = count
        if (pending.replies.length >= count) pending.done()
      },
      (error: unknown) => {
        logger.warn(
          { err: error, kind: message.kind },
          'cluster: request to other instances failed',
        )
        pending.done()
      },
    )
    try {
      await answered
      return { replies: [...pending.replies], peers }
    } finally {
      clearTimeout(timer)
      peerRequests.delete(requestId)
    }
  }

  /** Réponse d'une autre instance à une demande de `askPeers` (ignorée si elle n'est pas d'ici). */
  const receivePeerReply = (requestId: string, reply: ClusterMessage): void => {
    const pending = peerRequests.get(requestId)
    if (!pending) return
    pending.replies.push(reply)
    if (pending.replies.length >= pending.expected) pending.done()
  }

  /**
   * Journal de l'historique : écrit ce qui attend pour le projet sur cette instance, le demande
   * aux autres et attend leurs réponses (au plus `FLUSH_ACK_TIMEOUT_MS`) : la version créée
   * ensuite par l'API contient les dernières frappes reçues par toutes les instances, avec leur
   * auteur. Après le délai, l'API continue ; l'état enregistré rattrape le texte, sans auteur.
   */
  const flushUpdates = async (projectId: string): Promise<FlushUpdatesResponse> => {
    const [flushed, { replies, peers }] = await Promise.all([
      recorder.flush(projectId),
      askPeers(
        (requestId) => ({ kind: 'flush-updates', projectId, requestId }),
        FLUSH_ACK_TIMEOUT_MS,
      ),
    ])
    if (peers === null || replies.length < peers) {
      logger.warn({ projectId, peers }, 'history flush not acknowledged by every instance')
    }
    return { flushed }
  }

  /** États Yjs des documents du projet chargés sur cette instance (réponse `document-states`). */
  const loadedStates = (instance: Hocuspocus, projectId: string) => {
    const documents: { documentId: string; snapshot: string }[] = []
    for (const [name, document] of instance.documents) {
      const target = parseDocumentName(name)
      if (target?.projectId !== projectId) continue
      documents.push({ documentId: target.documentId, snapshot: encodeDocumentState(document) })
    }
    return documents
  }

  /**
   * États des documents du projet ouverts sur les autres instances (vide sans Redis), par
   * document : ce que l'instantané doit contenir. `complete` : chaque autre instance a répondu
   * dans le délai, avec des états lisibles (toujours vrai sans Redis).
   */
  const peerStates = async (
    projectId: string,
  ): Promise<{ states: Map<string, Y.Snapshot[]>; complete: boolean }> => {
    const states = new Map<string, Y.Snapshot[]>()
    if (bus === singleInstanceBus) return { states, complete: true }
    // Attente bornée, envoi compris (`askPeers`) : sans bus, le texte connu ici fait foi.
    const { replies, peers } = await askPeers(
      (requestId) => ({ kind: 'document-states-request', projectId, requestId }),
      SNAPSHOT_PEERS_TIMEOUT_MS,
    )
    let complete = peers !== null && replies.length >= peers
    if (!complete) {
      logger.warn({ projectId, peers }, 'some instances did not describe their documents')
    }
    for (const reply of replies) {
      if (reply.kind !== 'document-states') continue
      for (const { documentId, snapshot } of reply.documents) {
        const state = decodeDocumentState(snapshot)
        if (!state) {
          complete = false
          continue
        }
        states.set(documentId, [...(states.get(documentId) ?? []), state])
      }
    }
    return { states, complete }
  }

  /**
   * Document ouvert ici par une connexion directe, qui a rattrapé les copies des autres instances
   * (`peerStates`) : pour appliquer des suggestions ou lire celles déjà appliquées. Contrairement à
   * l'instantané, un rattrapage incomplet (instance muette, délai dépassé) est un échec
   * (`unavailable`, rien n'est fait) : une ancre posée sur un texte pas encore reçu ici serait
   * déclarée obsolète à tort, une suggestion appliquée ailleurs le serait une seconde fois.
   */
  const caughtUpDocument = async (
    connection: Awaited<ReturnType<Hocuspocus['openDirectConnection']>>,
    projectId: string,
    documentId: string,
    remote: { states: Map<string, Y.Snapshot[]>; complete: boolean },
  ): Promise<Y.Doc | 'unavailable'> => {
    const document = connection.document
    if (!remote.complete || !document) return 'unavailable'
    const states = remote.states.get(documentId) ?? []
    if (
      states.length > 0 &&
      !(await waitForStates(document, states, Date.now() + SNAPSHOT_SYNC_TIMEOUT_MS))
    ) {
      logger.warn(
        { documentName: documentName(projectId, documentId) },
        'suggestions: document not caught up with other instances',
      )
      return 'unavailable'
    }
    return document
  }

  /**
   * Remplace le texte d'un document (restauration d'une version) par une modification minimale,
   * faite par une connexion directe au nom du compte qui restaure : les clients connectés la
   * reçoivent, elle est journalisée avec cet auteur et enregistrée en base. Null : document
   * inconnu.
   */
  const replaceDocument = async (
    instance: Hocuspocus,
    projectId: string,
    documentId: string,
    request: ReplaceDocumentRequest,
  ): Promise<ReplaceDocumentResponse | null> => {
    if (!(await store.documentExists(projectId, documentId))) return null
    const context: ConnectionContext = {
      userId: request.userId,
      userName: null,
      avatarUrl: null,
      projectId,
      documentId,
      meta: false,
      role: 'editor',
      issuedAt: Math.floor(Date.now() / 1000),
      roleCheckedAt: Date.now(),
      rejectedUpdates: 0,
    }
    const connection = await instance.openDirectConnection(
      documentName(projectId, documentId),
      context,
    )
    let changed = false
    try {
      for (let attempt = 0; attempt < REPLACE_ATTEMPTS; attempt++) {
        await connection.transact((document) => {
          if (replaceTextMinimally(document.getText(TEXT_FIELD), request.content)) changed = true
        })
        if (!options.REDIS_URL) break
        await new Promise((resolve) => setTimeout(resolve, REPLACE_SETTLE_MS))
        if (connection.document && textOf(connection.document) === request.content) break
      }
    } finally {
      await connection.disconnect()
    }
    await recorder.flush(projectId)
    logger.info({ projectId, documentId, userId: request.userId, changed }, 'document replaced')
    return { changed }
  }

  /**
   * Suggestions acceptées (suivi des modifications) : appliquées au document Yjs en cours
   * d'édition, chacune par une connexion directe au nom de son auteur (le journal de l'historique
   * lui attribue la modification), avec une origine dédiée (`suggestion` : identifiant et
   * décideur, journalisés). Avec plusieurs instances, la copie d'ici rattrape d'abord celles des
   * autres (comme l'instantané) : une ancre posée sur un texte tapé ailleurs se résout ; si ce
   * rattrapage est incomplet, rien n'est appliqué (`unavailable`, 503 : l'API ne marque rien). Le
   * décideur doit encore pouvoir décider (rôle relu en base) ; sinon `forbidden`. Null : document
   * inconnu.
   */
  const applySuggestions = async (
    instance: Hocuspocus,
    projectId: string,
    documentId: string,
    request: ApplySuggestionsRequest,
  ): Promise<ApplySuggestionsResponse | 'forbidden' | 'unavailable' | null> => {
    if (!(await store.documentExists(projectId, documentId))) return null
    const role = await store.memberRole(projectId, request.decidedBy, Math.floor(Date.now() / 1000))
    if (!role || !canDecideSuggestion(role)) return 'forbidden'
    const name = documentName(projectId, documentId)
    const remote = await peerStates(projectId)
    const connections = new Map<string, Awaited<ReturnType<Hocuspocus['openDirectConnection']>>>()
    const connectionFor = async (authorId: string, suggestionId: string) => {
      let connection = connections.get(authorId)
      if (!connection) {
        const context: ConnectionContext = {
          userId: authorId,
          userName: null,
          avatarUrl: null,
          projectId,
          documentId,
          meta: false,
          role: 'editor',
          issuedAt: Math.floor(Date.now() / 1000),
          roleCheckedAt: Date.now(),
          rejectedUpdates: 0,
          suggestion: { id: suggestionId, decidedBy: request.decidedBy },
        }
        connection = await instance.openDirectConnection(name, context)
        connections.set(authorId, connection)
      }
      return connection
    }
    const results: ApplySuggestionsResponse['results'] = []
    try {
      const first = request.suggestions[0]
      if (!first) return { results }
      const opened = await connectionFor(first.authorId, first.id)
      if ((await caughtUpDocument(opened, projectId, documentId, remote)) === 'unavailable') {
        return 'unavailable'
      }
      for (const suggestion of request.suggestions) {
        const connection = await connectionFor(suggestion.authorId, suggestion.id)
        const origin = connection.context as ConnectionContext
        origin.suggestion = { id: suggestion.id, decidedBy: request.decidedBy }
        let outcome: ApplySuggestionsResponse['results'][number]['outcome'] = 'stale'
        await connection.transact((document) => {
          outcome = applySuggestion(document.getText(TEXT_FIELD), suggestion, {
            decidedBy: request.decidedBy,
          })
        })
        results.push({ id: suggestion.id, outcome })
        logger.info(
          {
            projectId,
            documentId,
            suggestionId: suggestion.id,
            authorId: suggestion.authorId,
            decidedBy: request.decidedBy,
            outcome,
          },
          'suggestion applied',
        )
      }
    } finally {
      for (const connection of connections.values()) await connection.disconnect()
    }
    await recorder.flush(projectId)
    return { results }
  }

  /**
   * Suggestions déjà appliquées au document parmi `request.ids` (map `APPLIED_SUGGESTIONS_FIELD`),
   * après rattrapage des autres instances : `unavailable` s'il est incomplet. Null : document
   * inconnu. Lecture seule ; le document reste chargé le temps habituel.
   */
  const appliedSuggestions = async (
    instance: Hocuspocus,
    projectId: string,
    documentId: string,
    request: AppliedSuggestionsRequest,
  ): Promise<AppliedSuggestionsResponse | 'unavailable' | null> => {
    if (!(await store.documentExists(projectId, documentId))) return null
    const remote = await peerStates(projectId)
    const connection = await instance.openDirectConnection(documentName(projectId, documentId))
    try {
      const document = await caughtUpDocument(connection, projectId, documentId, remote)
      if (document === 'unavailable') return 'unavailable'
      const map = document.getMap<string>(APPLIED_SUGGESTIONS_FIELD)
      return {
        applied: [...new Set(request.ids)].flatMap((id) => {
          const decidedBy = map.get(id)
          return typeof decidedBy === 'string' ? [{ id, decidedBy }] : []
        }),
      }
    } finally {
      await connection.disconnect({ unloadImmediately: false })
    }
  }

  /**
   * Texte courant de chaque document du projet. Un document ouvert fait foi : il contient les
   * modifications pas encore enregistrées. Avec plusieurs instances, un document ouvert sur une
   * autre instance peut avoir des modifications que la copie d'ici n'a pas encore reçues (ou, s'il
   * n'est pas chargé ici, que la base n'a pas encore) : chaque autre instance décrit l'état de
   * ses documents du projet, et le texte n'est lu qu'une fois cet état reçu par l'extension Redis
   * (attente bornée par `SNAPSHOT_SYNC_TIMEOUT_MS` pour tout l'instantané, puis texte connu).
   */
  const snapshot = async (instance: Hocuspocus, projectId: string): Promise<ProjectSnapshot> => {
    // Le journal de l'historique est à jour pour ce projet avant toute version (compilation).
    await recorder.flush(projectId)
    const ids = await store.documentIds(projectId)
    const { states: remote } = await peerStates(projectId)
    const deadline = Date.now() + SNAPSHOT_SYNC_TIMEOUT_MS
    const caughtUp = async (name: string, document: Y.Doc, id: string) => {
      const states = remote.get(id) ?? []
      if (states.length > 0 && !(await waitForStates(document, states, deadline))) {
        logger.warn({ documentName: name }, 'snapshot: document not caught up with other instances')
      }
    }
    const documents = []
    for (const id of ids) {
      const name = documentName(projectId, id)
      const loaded = instance.documents.get(name)
      let content: string
      if (loaded) {
        await caughtUp(name, loaded, id)
        content = textOf(loaded)
      } else {
        // Chargé par Hocuspocus (et partagé avec un client qui l'ouvrirait au même moment), puis
        // déchargé après l'enregistrement différé habituel, sans attendre : avec Redis, un
        // déchargement immédiat coûte environ 2 s par document (verrou et délais de l'extension),
        // assez pour dépasser le délai de l'API sur un projet de quelques fichiers. Rien n'est
        // écrit si le texte n'a pas changé.
        const connection = await instance.openDirectConnection(name)
        try {
          if (connection.document) await caughtUp(name, connection.document, id)
          content = connection.document ? textOf(connection.document) : ''
        } finally {
          await connection.disconnect({ unloadImmediately: false })
        }
      }
      documents.push({ id, content, sha256: sha256(content) })
    }
    return { projectId, documents }
  }

  /**
   * Ferme les connexions d'un document. `closed` ne compte que les documents qui avaient encore des
   * connexions : un document dont on vient de fermer les connexions peut rester un instant chargé,
   * le temps que Hocuspocus le décharge, et ne doit pas être compté une seconde fois.
   */
  const closeDocument = (instance: Hocuspocus, documentId: string): CloseDocumentResponse => {
    let closed = false
    for (const [name, document] of instance.documents) {
      if (parseDocumentName(name)?.documentId !== documentId) continue
      if (document.getConnectionsCount() > 0) closed = true
      instance.closeConnections(name)
    }
    return { closed }
  }

  /**
   * Envoie un événement aux connexions des documents meta de cette instance : ceux du projet, ou
   * tous si `projectId` est null (bannière), avec alors les canaux des utilisateurs (toutes les
   * pages connectées, `user-channel.ts`). Message sans état adressé à chaque connexion, et non
   * `broadcastStateless` du document, que l'extension Redis relaierait en double : les autres
   * instances reçoivent l'événement par le bus, même sans document meta chargé ici.
   */
  const deliverEvent = (
    instance: Hocuspocus,
    projectId: string | null,
    message: ProjectEventMessage,
  ): number => {
    const payload = JSON.stringify(message)
    let delivered = projectId === null ? userChannels.deliverToAll(instance, payload) : 0
    for (const [name, document] of instance.documents) {
      const meta = parseMetaDocumentName(name)
      if (!meta || (projectId !== null && meta.projectId !== projectId)) continue
      for (const connection of document.getConnections()) {
        connection.sendStateless(payload)
        delivered++
      }
    }
    return delivered
  }

  /** Publie un événement : livré sur cette instance, puis relayé aux autres. */
  const publishEvent = async (
    instance: Hocuspocus,
    projectId: string | null,
    message: ProjectEventMessage,
  ): Promise<PublishEventResponse> => {
    const delivered = deliverEvent(instance, projectId, message)
    await bus.publish({ kind: 'project-event', projectId, message })
    logger.debug({ projectId, type: message.event.type, delivered }, 'project event published')
    return { delivered }
  }

  /**
   * Ferme toutes les connexions d'un utilisateur, sur tous les documents ouverts de cette
   * instance et son canal. Sa reconnexion est refusée par onAuthenticate (compte banni ou
   * supprimé).
   */
  const disconnectUser = (instance: Hocuspocus, userId: string): DisconnectUserResponse => {
    let connections = userChannels.disconnectUser(instance, userId)
    for (const { connection, context } of [...access.connectionsOf(instance)]) {
      if (context.userId === userId) {
        connection.readOnly = true
        connection.close(FORBIDDEN)
        connections++
      }
    }
    if (connections > 0) logger.info({ userId, connections }, 'user disconnected')
    return { connections }
  }

  const handleRequest = async (
    instance: Hocuspocus,
    request: IncomingMessage,
    response: ServerResponse,
  ) => {
    const path = new URL(request.url ?? '/', 'http://realtime').pathname
    if (request.method === 'GET' && path === '/health') {
      sendJson(response, 200, { status: 'ok', documents: instance.getDocumentsCount() })
      return
    }
    if (!path.startsWith('/internal/')) {
      sendJson(response, 404, { code: 'E_NOT_FOUND' })
      return
    }
    if (!sameSecret(request.headers[INTERNAL_TOKEN_HEADER], options.INTERNAL_TOKEN)) {
      sendJson(response, 401, { code: 'E_UNAUTHORIZED' })
      return
    }
    const snapshotMatch = request.method === 'GET' ? SNAPSHOT_ROUTE.exec(path) : null
    if (snapshotMatch?.[1]) {
      sendJson(response, 200, await snapshot(instance, snapshotMatch[1]))
      return
    }
    // Les effets ci-dessous valent pour cette instance (compte renvoyé), puis sont relayés aux
    // autres par le bus.
    const closeMatch = request.method === 'POST' ? CLOSE_ROUTE.exec(path) : null
    if (closeMatch?.[1]) {
      const result = closeDocument(instance, closeMatch[1])
      await bus.publish({ kind: 'document-close', documentId: closeMatch[1] })
      sendJson(response, 200, result)
      return
    }
    const flushMatch = request.method === 'POST' ? FLUSH_UPDATES_ROUTE.exec(path) : null
    if (flushMatch?.[1]) {
      sendJson(response, 200, await flushUpdates(flushMatch[1]))
      return
    }
    const replaceMatch = request.method === 'POST' ? REPLACE_ROUTE.exec(path) : null
    if (replaceMatch?.[1] && replaceMatch[2]) {
      const parsed = replaceDocumentRequestSchema.safeParse(
        await readJson(request, MAX_REPLACE_BYTES),
      )
      if (!parsed.success) {
        sendJson(response, 400, { code: 'E_INVALID_REQUEST' })
        return
      }
      const result = await replaceDocument(instance, replaceMatch[1], replaceMatch[2], parsed.data)
      if (result) sendJson(response, 200, result)
      else sendJson(response, 404, { code: 'E_NOT_FOUND' })
      return
    }
    const applyMatch = request.method === 'POST' ? APPLY_SUGGESTIONS_ROUTE.exec(path) : null
    if (applyMatch?.[1] && applyMatch[2]) {
      const parsed = applySuggestionsRequestSchema.safeParse(
        await readJson(request, MAX_REPLACE_BYTES),
      )
      if (!parsed.success) {
        sendJson(response, 400, { code: 'E_INVALID_REQUEST' })
        return
      }
      const result = await applySuggestions(instance, applyMatch[1], applyMatch[2], parsed.data)
      if (result === null) sendJson(response, 404, { code: 'E_NOT_FOUND' })
      else if (result === 'forbidden') sendJson(response, 403, { code: 'E_FORBIDDEN' })
      else if (result === 'unavailable') sendJson(response, 503, { code: 'E_NOT_CAUGHT_UP' })
      else sendJson(response, 200, result)
      return
    }
    const appliedMatch = request.method === 'POST' ? APPLIED_SUGGESTIONS_ROUTE.exec(path) : null
    if (appliedMatch?.[1] && appliedMatch[2]) {
      const parsed = appliedSuggestionsRequestSchema.safeParse(await readJson(request))
      if (!parsed.success) {
        sendJson(response, 400, { code: 'E_INVALID_REQUEST' })
        return
      }
      const result = await appliedSuggestions(
        instance,
        appliedMatch[1],
        appliedMatch[2],
        parsed.data,
      )
      if (result === null) sendJson(response, 404, { code: 'E_NOT_FOUND' })
      else if (result === 'unavailable') sendJson(response, 503, { code: 'E_NOT_CAUGHT_UP' })
      else sendJson(response, 200, result)
      return
    }
    const userMatch = request.method === 'POST' ? DISCONNECT_USER_ROUTE.exec(path) : null
    if (userMatch?.[1]) {
      const result = disconnectUser(instance, userMatch[1])
      await bus.publish({ kind: 'user-disconnect', userId: userMatch[1] })
      sendJson(response, 200, result)
      return
    }
    const eventsMatch = request.method === 'POST' ? PROJECT_EVENTS_ROUTE.exec(path) : null
    if (eventsMatch?.[1]) {
      const parsed = publishProjectEventRequestSchema.safeParse(await readJson(request))
      if (!parsed.success) {
        sendJson(response, 400, { code: 'E_INVALID_EVENT' })
        return
      }
      const message = projectEventMessage(parsed.data.event)
      sendJson(response, 200, await publishEvent(instance, eventsMatch[1], message))
      return
    }
    if (request.method === 'POST' && path === BROADCAST_EVENTS_ROUTE) {
      const parsed = publishBroadcastEventRequestSchema.safeParse(await readJson(request))
      if (!parsed.success) {
        sendJson(response, 400, { code: 'E_INVALID_EVENT' })
        return
      }
      const message = projectEventMessage(parsed.data.event)
      sendJson(response, 200, await publishEvent(instance, null, message))
      return
    }
    const memberMatch = request.method === 'POST' ? MEMBER_CHANGED_ROUTE.exec(path) : null
    if (memberMatch?.[1] && memberMatch[2]) {
      const change = { projectId: memberMatch[1], userId: memberMatch[2] }
      const result = await access.applyMemberChange(instance, change)
      await fanout.publish(change)
      if (result.closed + result.updated > 0)
        logger.info({ ...change, ...result }, 'member changed')
      sendJson(response, 200, result)
      return
    }
    sendJson(response, 404, { code: 'E_NOT_FOUND' })
  }

  /** Canal d'un utilisateur : jeton `scope: 'user'` de son titulaire, compte actif. */
  const authenticateUserChannel = async (
    token: string,
    userId: string,
  ): Promise<UserChannelContext> => {
    const claims = verifyUserRealtimeToken(token, options.REALTIME_TOKEN_SECRET)
    if (!claims) throw new AccessDenied('invalid or expired token')
    if (claims.sub !== userId) throw new AccessDenied('token is for another user')
    if (!(await store.accountActive(claims.sub, claims.iat))) {
      throw new AccessDenied('account banned, deleted or signed out')
    }
    return { channel: 'user', userId: claims.sub, issuedAt: claims.iat, rejectedUpdates: 0 }
  }

  return new Server<ConnectionContext | UserChannelContext>({
    name: 'kaxolax-realtime',
    address: options.HOST,
    port: options.PORT,
    quiet: true,
    stopOnSignals: false,
    debounce: options.STORE_DEBOUNCE_MS,
    maxDebounce: options.STORE_MAX_DEBOUNCE_MS,
    websocketOptions: { maxPayload: MAX_MESSAGE_BYTES },

    async onAuthenticate({ token, documentName: name, connectionConfig, socketId }) {
      try {
        const target = parseRealtimeDocumentName(name)
        if (!target) throw new AccessDenied('malformed document name')
        if (target.kind === 'user') {
          const context = await authenticateUserChannel(token, target.userId)
          // Sans contenu : lecture seule, les événements arrivent en messages sans état.
          connectionConfig.readOnly = true
          logger.debug({ socketId, userId: context.userId }, 'user channel authenticated')
          return context
        }
        const claims = verifyRealtimeToken(token, options.REALTIME_TOKEN_SECRET)
        if (!claims) throw new AccessDenied('invalid or expired token')
        if (target.projectId !== claims.projectId)
          throw new AccessDenied('token is for another project')
        // Le rôle est relu en base : un membre retiré, un compte banni ou supprimé, ou dont les
        // sessions ont été révoquées depuis l'émission du jeton, ne se reconnecte pas avec un
        // ancien jeton. Même règle pour le document meta : tout membre du projet s'y connecte.
        const role = await store.memberRole(target.projectId, claims.sub, claims.iat)
        if (!role) throw new AccessDenied('not an active member of the project')
        if (
          target.kind === 'text' &&
          !(await store.documentExists(target.projectId, target.documentId))
        ) {
          throw new AccessDenied('unknown document')
        }
        const meta = target.kind === 'meta'
        // Matrice des permissions : seuls les rôles qui éditent écrivent (owner, editor). Le
        // document meta n'a pas de contenu : tout le monde y est en lecture seule (awareness).
        connectionConfig.readOnly = meta || !canEdit(role)
        const profile = await store.presenceProfile(claims.sub)
        logger.debug(
          { socketId, documentName: name, userId: claims.sub, role },
          'connection authenticated',
        )
        return {
          userId: claims.sub,
          userName: profile?.fullName ?? null,
          avatarUrl: profile?.avatarUrl ?? null,
          projectId: target.projectId,
          documentId: meta ? null : target.documentId,
          meta,
          role,
          issuedAt: claims.iat,
          roleCheckedAt: Date.now(),
          rejectedUpdates: 0,
        } satisfies ConnectionContext
      } catch (error) {
        if (error instanceof AccessDenied) {
          logger.info({ socketId, documentName: name, reason: error.detail }, 'connection refused')
        }
        throw error
      }
    },

    /**
     * Seconde vérification, une fois la connexion attachée au document (après son chargement) :
     * un bannissement, une suppression ou une révocation validés entre onAuthenticate et l'attache
     * ont pu manquer `/internal/users/:id/disconnect`, qui ne voit que les connexions attachées.
     * L'API appelle cette route après avoir validé l'effet : l'une des deux vérifications le voit.
     * Même chose pour un changement de rôle ou un retrait (`…/members/:userId/changed`).
     */
    async connected({ connection }) {
      await access.recheck(connection)
      await userChannels.recheck(connection)
    },

    /**
     * Map des suggestions appliquées protégée des clients (voir `guardAppliedSuggestions`) ; rien
     * sur le document meta ni sur le canal d'un utilisateur.
     */
    afterLoadDocument({ documentName: name, document }) {
      if (parseDocumentName(name)) guardAppliedSuggestions(document, logger)
      return Promise.resolve()
    },

    /**
     * Rôle vérifié à chaque mise à jour Yjs (voir `createAccessControl`), puis stockage du plan du
     * propriétaire (voir `createStorageGuard`).
     */
    async beforeSync({ connection, document, type, payload }) {
      userChannels.beforeSync(connection, document, type, payload)
      await access.beforeSync(connection, document, type, payload)
      await storage.beforeSync(connection, type)
    },

    /**
     * Origine de chaque mise à jour appliquée (historique) : celles des connexions de cette
     * instance et des restaurations faites ici. Une mise à jour relayée par Redis a été
     * journalisée par l'instance qui l'a reçue (voir `updates.ts`).
     */
    onChange({ documentName: name, update, transactionOrigin, context }) {
      const target = parseDocumentName(name)
      if (!target || !isTransactionOrigin(transactionOrigin)) return Promise.resolve()
      if (transactionOrigin.source === 'redis') return Promise.resolve()
      const userId = (context as Partial<ConnectionContext> | undefined)?.userId
      recorder.record(
        target.projectId,
        target.documentId,
        typeof userId === 'string' ? userId : null,
        update,
      )
      return Promise.resolve()
    },

    /**
     * Identité de la présence imposée par le serveur (voir `presence.ts`) ; aucune présence sur le
     * canal d'un utilisateur.
     */
    beforeHandleAwareness({ connection, document, states }) {
      if (connection && userChannelContextOf(connection)) states.clear()
      else enforcePresenceIdentity({ connection, document, states }, logger)
      return Promise.resolve()
    },

    /** Présence d'une connexion fermée retirée aussi sur les autres instances (voir `cluster.ts`). */
    async onDisconnect({ context, document }) {
      const clientIds = departedClients(context, document)
      if (clientIds.length === 0) return
      try {
        await bus.publish({ kind: 'awareness-departed', documentName: document.name, clientIds })
      } catch (error) {
        // Au pire, l'état expire chez les autres instances (30 s, y-protocols).
        logger.warn({ err: error, documentName: document.name }, 'awareness departure not relayed')
      }
    },

    async onListen({ instance }) {
      fanout.subscribe(async (change) => {
        await access.applyMemberChange(instance, change)
      })
      bus.subscribe((message) => {
        if (message.kind === 'user-disconnect') disconnectUser(instance, message.userId)
        else if (message.kind === 'document-close') closeDocument(instance, message.documentId)
        else if (message.kind === 'awareness-departed') {
          const document = instance.documents.get(message.documentName)
          if (document) removeRemoteClients(document, message.clientIds)
        } else if (message.kind === 'project-event') {
          deliverEvent(instance, message.projectId, message.message)
        } else if (message.kind === 'flush-updates') {
          return recorder
            .flush(message.projectId)
            .then(() => bus.publish({ kind: 'flush-updates-done', requestId: message.requestId }))
        } else if (message.kind === 'document-states-request') {
          return bus.publish({
            kind: 'document-states',
            requestId: message.requestId,
            documents: loadedStates(instance, message.projectId),
          })
        } else if (message.kind === 'flush-updates-done' || message.kind === 'document-states') {
          receivePeerReply(message.requestId, message)
        }
        return Promise.resolve()
      })
      await bus.ready()
      if (sweepMs > 0) {
        sweepTimer = setInterval(() => {
          access.sweep(instance).catch((error: unknown) => {
            logger.error({ err: error }, 'role sweep failed')
          })
          userChannels.sweep(instance).catch((error: unknown) => {
            logger.error({ err: error }, 'user channel sweep failed')
          })
        }, sweepMs)
        sweepTimer.unref()
      }
    },

    async onDestroy() {
      clearInterval(sweepTimer)
      await recorder.flush()
      await bus.close()
    },

    extensions: [
      ...redisExtensions,
      new Database({
        fetch: async ({ documentName: name }) => {
          const target = parseDocumentName(name)
          return target ? store.fetchState(target.projectId, target.documentId) : null
        },
        store: async ({ documentName: name, document, state }) => {
          const target = parseDocumentName(name)
          if (!target) return
          try {
            const written = await store.storeState(
              target.projectId,
              target.documentId,
              state,
              sha256(textOf(document)),
            )
            logger.debug({ documentName: name, written }, 'document stored')
            if (written) storage.invalidate(target.projectId)
          } catch (error) {
            logger.error({ err: error, documentName: name }, 'failed to store document')
            throw error
          }
        },
      }),
    ],

    async onRequest({ request, response, instance }) {
      try {
        await handleRequest(instance, request, response)
      } catch (error) {
        if (error instanceof BadRequest) {
          logger.warn({ url: request.url, reason: error.message }, 'internal request refused')
          if (!response.headersSent) sendJson(response, 400, { code: 'E_BAD_REQUEST' })
        } else {
          logger.error({ err: error, url: request.url }, 'internal request failed')
          if (!response.headersSent) sendJson(response, 500, { code: 'E_INTERNAL' })
        }
      }
      // Réponse envoyée : un rejet vide arrête la chaîne des hooks et la réponse par défaut.
      // eslint-disable-next-line @typescript-eslint/only-throw-error
      throw null
    },
  })
}
