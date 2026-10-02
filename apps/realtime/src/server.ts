import { createHash, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { Database } from '@hocuspocus/extension-database'
import { Redis as RedisExtension } from '@hocuspocus/extension-redis'
import { type Extension, type Hocuspocus, Server } from '@hocuspocus/server'
import {
  documentName,
  parseDocumentName,
  parseMetaDocumentName,
  parseRealtimeDocumentName,
  textOf,
} from '@kaxolax/collab'
import { verifyRealtimeToken } from '@kaxolax/collab/token'
import {
  canEdit,
  type CloseDocumentResponse,
  type DisconnectUserResponse,
  INTERNAL_TOKEN_HEADER,
  MAX_PROJECT_EVENT_BYTES,
  type ProjectEventMessage,
  projectEventMessage,
  type ProjectSnapshot,
  publishBroadcastEventRequestSchema,
  type PublishEventResponse,
  publishProjectEventRequestSchema,
} from '@kaxolax/contracts'
import type { Logger } from 'pino'
import { type ConnectionContext, createAccessControl, FORBIDDEN } from './access.js'
import {
  type ClusterBus,
  memberChangeFanout,
  RedisClusterBus,
  redisConnectionOptions,
  singleInstanceBus,
} from './cluster.js'
import type { RealtimeConfig } from './config.js'
import { departedClients, enforcePresenceIdentity, removeRemoteClients } from './presence.js'
import { createStorageGuard } from './storage.js'
import type { DocumentStore } from './store.js'

export type { ConnectionContext } from './access.js'

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
      'ROLE_RECHECK_MS' | 'ROLE_SWEEP_MS' | 'STORAGE_CHECK_MS' | 'REDIS_URL' | 'REDIS_PREFIX'
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

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request as AsyncIterable<unknown>) {
    const buffer = Buffer.isBuffer(chunk)
      ? chunk
      : Buffer.from(typeof chunk === 'string' ? chunk : '')
    size += buffer.length
    if (size > MAX_REQUEST_BYTES) throw new BadRequest('request body too large')
    chunks.push(buffer)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new BadRequest('invalid JSON body')
  }
}

/** Refus d'authentification : le client reçoit un motif générique, le journal garde le détail. */
class AccessDenied extends Error {
  constructor(readonly detail: string) {
    super('permission-denied')
  }
}

/**
 * Service temps réel. Avec `REDIS_URL`, plusieurs instances partagent les documents, l'awareness
 * et les messages sans état (extension Redis de Hocuspocus) ; un bus Redis pub/sub (`cluster.ts`)
 * relaie les changements de membres, les fermetures de connexions et les événements du projet.
 */
export function createRealtimeServer(options: ServerOptions, store: DocumentStore, logger: Logger) {
  const redisPrefix = options.REDIS_PREFIX ?? 'kaxolax-realtime'
  const bus: ClusterBus = options.REDIS_URL
    ? new RedisClusterBus(options.REDIS_URL, `${redisPrefix}:cluster`, logger)
    : singleInstanceBus
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
  const sweepMs = options.ROLE_SWEEP_MS ?? 30_000
  let sweepTimer: NodeJS.Timeout | undefined
  const snapshot = async (instance: Hocuspocus, projectId: string): Promise<ProjectSnapshot> => {
    const documents = []
    for (const id of await store.documentIds(projectId)) {
      const name = documentName(projectId, id)
      // Un document ouvert fait foi : il contient les modifications pas encore enregistrées.
      const loaded = instance.documents.get(name)
      let content: string
      if (loaded) {
        content = textOf(loaded)
      } else {
        // Chargé par Hocuspocus (et partagé avec un client qui l'ouvrirait au même moment), puis
        // déchargé : rien n'est écrit si le texte n'a pas changé.
        const connection = await instance.openDirectConnection(name)
        try {
          content = connection.document ? textOf(connection.document) : ''
        } finally {
          await connection.disconnect()
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
   * tous si `projectId` est null (bannière). Message sans état adressé à chaque connexion, et non
   * `broadcastStateless` du document, que l'extension Redis relaierait en double : les autres
   * instances reçoivent l'événement par le bus, même sans document meta chargé ici.
   */
  const deliverEvent = (
    instance: Hocuspocus,
    projectId: string | null,
    message: ProjectEventMessage,
  ): number => {
    const payload = JSON.stringify(message)
    let delivered = 0
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
   * instance. Sa reconnexion est refusée par onAuthenticate (compte banni ou supprimé).
   */
  const disconnectUser = (instance: Hocuspocus, userId: string): DisconnectUserResponse => {
    let connections = 0
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

  return new Server<ConnectionContext>({
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
        const claims = verifyRealtimeToken(token, options.REALTIME_TOKEN_SECRET)
        if (!claims) throw new AccessDenied('invalid or expired token')
        const target = parseRealtimeDocumentName(name)
        if (!target) throw new AccessDenied('malformed document name')
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
    },

    /**
     * Rôle vérifié à chaque mise à jour Yjs (voir `createAccessControl`), puis stockage du plan du
     * propriétaire (voir `createStorageGuard`).
     */
    async beforeSync({ connection, document, type, payload }) {
      await access.beforeSync(connection, document, type, payload)
      await storage.beforeSync(connection, type)
    },

    /** Identité de la présence imposée par le serveur (voir `presence.ts`). */
    beforeHandleAwareness({ connection, document, states }) {
      enforcePresenceIdentity({ connection, document, states }, logger)
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
        }
        return Promise.resolve()
      })
      await bus.ready()
      if (sweepMs > 0) {
        sweepTimer = setInterval(() => {
          access.sweep(instance).catch((error: unknown) => {
            logger.error({ err: error }, 'role sweep failed')
          })
        }, sweepMs)
        sweepTimer.unref()
      }
    },

    async onDestroy() {
      clearInterval(sweepTimer)
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
