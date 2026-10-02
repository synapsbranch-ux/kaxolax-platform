import { createHash, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { Database } from '@hocuspocus/extension-database'
import { type Hocuspocus, Server } from '@hocuspocus/server'
import { documentName, parseDocumentName, textOf } from '@kaxolax/collab'
import { verifyRealtimeToken } from '@kaxolax/collab/token'
import {
  type CloseDocumentResponse,
  type DisconnectUserResponse,
  INTERNAL_TOKEN_HEADER,
  type ProjectRole,
  type ProjectSnapshot,
} from '@kaxolax/contracts'
import type { Logger } from 'pino'
import type { RealtimeConfig } from './config.js'
import type { DocumentStore } from './store.js'

/** Contexte d'une connexion authentifiée. */
export interface ConnectionContext {
  userId: string
  projectId: string
  documentId: string
  role: ProjectRole
  /** `iat` du jeton (secondes) : la révocation des sessions est revérifiée à l'attache. */
  issuedAt: number
}

type ServerOptions = Pick<
  RealtimeConfig,
  | 'HOST'
  | 'PORT'
  | 'REALTIME_TOKEN_SECRET'
  | 'INTERNAL_TOKEN'
  | 'STORE_DEBOUNCE_MS'
  | 'STORE_MAX_DEBOUNCE_MS'
>

/** Seuls ces rôles modifient le texte ; les autres reçoivent une connexion en lecture seule. */
const WRITER_ROLES: ReadonlySet<ProjectRole> = new Set(['owner', 'editor'])

/** Un message Yjs peut contenir tout l'état d'un document de 2 Mio, historique compris. */
const MAX_MESSAGE_BYTES = 16 * 1024 * 1024

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
const SNAPSHOT_ROUTE = new RegExp(`^/internal/projects/(${UUID})/snapshot$`)
const CLOSE_ROUTE = new RegExp(`^/internal/documents/(${UUID})/close$`)
const DISCONNECT_USER_ROUTE = new RegExp(`^/internal/users/(${UUID})/disconnect$`)

/** Fermeture imposée (compte banni ou supprimé) : même code que Forbidden de Hocuspocus. */
const FORBIDDEN = { code: 4403, reason: 'Forbidden' }

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

/** Refus d'authentification : le client reçoit un motif générique, le journal garde le détail. */
class AccessDenied extends Error {
  constructor(readonly detail: string) {
    super('permission-denied')
  }
}

export function createRealtimeServer(options: ServerOptions, store: DocumentStore, logger: Logger) {
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

  const closeDocument = (instance: Hocuspocus, documentId: string): CloseDocumentResponse => {
    let closed = false
    for (const name of instance.documents.keys()) {
      if (parseDocumentName(name)?.documentId === documentId) {
        instance.closeConnections(name)
        closed = true
      }
    }
    return { closed }
  }

  /**
   * Ferme toutes les connexions d'un utilisateur, sur tous les documents ouverts de cette
   * instance. Sa reconnexion est refusée par onAuthenticate (compte banni ou supprimé).
   */
  const disconnectUser = (instance: Hocuspocus, userId: string): DisconnectUserResponse => {
    let connections = 0
    for (const document of instance.documents.values()) {
      for (const connection of document.getConnections()) {
        const context = connection.context as Partial<ConnectionContext> | undefined
        if (context?.userId === userId) {
          connection.close(FORBIDDEN)
          connections++
        }
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
    const closeMatch = request.method === 'POST' ? CLOSE_ROUTE.exec(path) : null
    if (closeMatch?.[1]) {
      sendJson(response, 200, closeDocument(instance, closeMatch[1]))
      return
    }
    const userMatch = request.method === 'POST' ? DISCONNECT_USER_ROUTE.exec(path) : null
    if (userMatch?.[1]) {
      sendJson(response, 200, disconnectUser(instance, userMatch[1]))
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
        const target = parseDocumentName(name)
        if (!target) throw new AccessDenied('malformed document name')
        if (target.projectId !== claims.projectId)
          throw new AccessDenied('token is for another project')
        // Le rôle est relu en base : un membre retiré, un compte banni ou supprimé, ou dont les
        // sessions ont été révoquées depuis l'émission du jeton, ne se reconnecte pas avec un
        // ancien jeton.
        const role = await store.memberRole(target.projectId, claims.sub, claims.iat)
        if (!role) throw new AccessDenied('not an active member of the project')
        if (!(await store.documentExists(target.projectId, target.documentId))) {
          throw new AccessDenied('unknown document')
        }
        connectionConfig.readOnly = !WRITER_ROLES.has(role)
        logger.debug(
          { socketId, documentName: name, userId: claims.sub, role },
          'connection authenticated',
        )
        return {
          userId: claims.sub,
          projectId: target.projectId,
          documentId: target.documentId,
          role,
          issuedAt: claims.iat,
        }
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
     */
    async connected({ context, connection, documentName: name }) {
      let allowed = false
      try {
        allowed =
          (await store.memberRole(context.projectId, context.userId, context.issuedAt)) !== null
      } catch (error) {
        logger.error({ err: error, documentName: name }, 'could not recheck connection')
      }
      if (!allowed) {
        logger.info({ documentName: name, userId: context.userId }, 'connection closed on attach')
        connection.close(FORBIDDEN)
      }
    },

    extensions: [
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
        logger.error({ err: error, url: request.url }, 'internal request failed')
        if (!response.headersSent) sendJson(response, 500, { code: 'E_INTERNAL' })
      }
      // Réponse envoyée : un rejet vide arrête la chaîne des hooks et la réponse par défaut.
      // eslint-disable-next-line @typescript-eslint/only-throw-error
      throw null
    },
  })
}
