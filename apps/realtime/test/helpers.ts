import { randomUUID } from 'node:crypto'
import { HocuspocusProvider, HocuspocusProviderWebsocket } from '@hocuspocus/provider'
import {
  createDocumentState,
  documentName,
  metaDocumentName,
  userChannelName,
} from '@kaxolax/collab'
import { signRealtimeToken, signUserRealtimeToken } from '@kaxolax/collab/token'
import { type ProjectRole, REALTIME_TOKEN_TTL_SECONDS } from '@kaxolax/contracts'
import pg from 'pg'
import { pino } from 'pino'
import { WebSocket } from 'ws'
import * as Y from 'yjs'
import { createRealtimeServer, type RealtimeDependencies } from '../src/server.js'
import { DocumentStore } from '../src/store.js'
import { TEST_DATABASE } from './global-setup.js'

export const TOKEN_SECRET = 'test-realtime-token-secret-0123456789abcdef'
export const INTERNAL_TOKEN = 'test-internal-token-0123456789abcdefghij'
export const DATABASE_URL =
  process.env.REALTIME_TEST_DATABASE_URL ??
  `postgres://kaxolax:kaxolax@127.0.0.1:5432/${TEST_DATABASE}`

export type RealtimeServer = ReturnType<typeof createRealtimeServer>

export async function startServer(
  store: DocumentStore,
  storeDelayMs = 50,
  roles: { ROLE_RECHECK_MS?: number; ROLE_SWEEP_MS?: number } = {},
  redis: { REDIS_URL?: string; REDIS_PREFIX?: string } = {},
  history: { HISTORY_FLUSH_MS?: number } = {},
  dependencies: RealtimeDependencies = {},
): Promise<{ server: RealtimeServer; url: string; httpUrl: string }> {
  const server = createRealtimeServer(
    {
      HOST: '127.0.0.1',
      PORT: 0,
      REALTIME_TOKEN_SECRET: TOKEN_SECRET,
      INTERNAL_TOKEN,
      STORE_DEBOUNCE_MS: storeDelayMs,
      STORE_MAX_DEBOUNCE_MS: storeDelayMs * 4,
      // Filets désactivés par défaut : les tests vérifient d'abord la notification de l'API.
      ROLE_RECHECK_MS: roles.ROLE_RECHECK_MS ?? 60_000,
      ROLE_SWEEP_MS: roles.ROLE_SWEEP_MS ?? 0,
      ...redis,
      ...history,
    },
    store,
    pino({ level: 'silent' }),
    dependencies,
  )
  await server.listen()
  const base = `127.0.0.1:${String(server.address.port)}`
  return { server, url: `ws://${base}`, httpUrl: `http://${base}` }
}

export function openStore(): DocumentStore {
  return DocumentStore.connect(DATABASE_URL, false)
}

export function openPool(): pg.Pool {
  return new pg.Pool({ connectionString: DATABASE_URL, max: 2 })
}

/** Données minimales écrites directement en SQL : le service ne lit que ces colonnes. */
export async function seedProject(pool: pg.Pool, text = 'Bonjour') {
  const addUser = async () => {
    const id = randomUUID()
    await pool.query(`INSERT INTO users (id, clerk_user_id, email) VALUES ($1, $2, $3)`, [
      id,
      `user_${id.replaceAll('-', '')}`,
      `${id}@example.test`,
    ])
    return id
  }
  const owner = await addUser()
  // Tout projet appartient à un workspace (ici le workspace personnel du propriétaire).
  const workspaceId = randomUUID()
  await pool.query(
    `INSERT INTO workspaces (id, name, type, owner_id) VALUES ($1, 'Personal workspace', 'personal', $2)`,
    [workspaceId, owner],
  )
  const projectId = randomUUID()
  await pool.query(
    `INSERT INTO projects (id, owner_id, workspace_id, name, updated_at) VALUES ($1, $2, $3, 'Projet', now() - interval '1 day')`,
    [projectId, owner, workspaceId],
  )
  const addMember = async (role: ProjectRole) => {
    const id = role === 'owner' ? owner : await addUser()
    await pool.query(
      'INSERT INTO project_members (project_id, user_id, role) VALUES ($1, $2, $3)',
      [projectId, id, role],
    )
    return id
  }
  await addMember('owner')
  const addDocument = async (content: string) => {
    const id = randomUUID()
    await pool.query(
      `INSERT INTO documents (id, project_id, name, yjs_state, content_sha256) VALUES ($1, $2, $3, $4, NULL)`,
      [id, projectId, `${id}.tex`, Buffer.from(createDocumentState(content))],
    )
    return id
  }
  const documentId = await addDocument(text)
  return { pool, owner, projectId, documentId, addUser, addMember, addDocument }
}

export function tokenFor(
  userId: string,
  projectId: string,
  options: { role?: ProjectRole; secret?: string; expiresIn?: number; issuedIn?: number } = {},
): string {
  return signRealtimeToken(
    {
      sub: userId,
      projectId,
      role: options.role ?? 'owner',
      iat: Math.floor(Date.now() / 1000) + (options.issuedIn ?? 0),
      exp: Math.floor(Date.now() / 1000) + (options.expiresIn ?? REALTIME_TOKEN_TTL_SECONDS),
    },
    options.secret ?? TOKEN_SECRET,
  )
}

/** Jeton du canal temps réel d'un utilisateur (`POST /me/realtime-token` de l'API). */
export function userTokenFor(
  userId: string,
  options: { secret?: string; expiresIn?: number; issuedIn?: number } = {},
): string {
  return signUserRealtimeToken(
    {
      scope: 'user',
      sub: userId,
      iat: Math.floor(Date.now() / 1000) + (options.issuedIn ?? 0),
      exp: Math.floor(Date.now() / 1000) + (options.expiresIn ?? REALTIME_TOKEN_TTL_SECONDS),
    },
    options.secret ?? TOKEN_SECRET,
  )
}

export interface Client {
  provider: HocuspocusProvider
  doc: Y.Doc
  text: Y.Text
  /** Résolu à la première synchronisation, rejeté si l'authentification échoue. */
  ready: Promise<void>
  destroy: () => void
}

export function connect(url: string, projectId: string, documentId: string, token: string): Client {
  return connectTo(url, documentName(projectId, documentId), token)
}

/** Connexion au document meta du projet (présence et événements). */
export function connectMeta(
  url: string,
  projectId: string,
  token: string,
  options: { clientId?: number } = {},
): Client {
  return connectTo(url, metaDocumentName(projectId), token, options)
}

/** Connexion au canal d'un utilisateur (bannière système). */
export function connectUserChannel(url: string, userId: string, token: string): Client {
  return connectTo(url, userChannelName(userId), token)
}

/** `clientId` : clientId Yjs imposé (reconnexion d'un même client sur une autre instance). */
export function connectTo(
  url: string,
  name: string,
  token: string,
  options: { clientId?: number } = {},
): Client {
  const doc = new Y.Doc()
  if (options.clientId !== undefined) doc.clientID = options.clientId
  // Sous Node, le WebSocket vient de `ws` ; le navigateur utilise le sien.
  const socket = new HocuspocusProviderWebsocket({
    url,
    WebSocketPolyfill: WebSocket,
    delay: 50,
    minDelay: 50,
  })
  let provider!: HocuspocusProvider
  const ready = new Promise<void>((resolve, reject) => {
    provider = new HocuspocusProvider({
      websocketProvider: socket,
      name,
      token,
      document: doc,
      onSynced: () => {
        resolve()
      },
      onAuthenticationFailed: ({ reason }) => {
        reject(new Error(`authentication failed: ${reason}`))
      },
    })
  })
  provider.attach()
  // Un refus peut arriver avant que le test n'attende `ready` : il reste observable par `ready`.
  ready.catch(() => undefined)
  return {
    provider,
    doc,
    text: doc.getText('content'),
    ready,
    destroy: () => {
      provider.destroy()
      socket.destroy()
    },
  }
}

/** Attend qu'une condition devienne vraie (propagation réseau, écriture différée). */
export async function eventually(
  check: () => boolean | Promise<boolean>,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('condition not met in time')
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

/** Appel d'une route interne du service (en-tête du secret partagé). */
export async function internalPost(base: string, path: string, body?: unknown): Promise<Response> {
  return fetch(`${base}${path}`, {
    method: 'POST',
    headers: {
      'x-internal-token': INTERNAL_TOKEN,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
}

/** Messages sans état reçus par un client, tels quels. */
export function statelessMessages(client: Client): string[] {
  const received: string[] = []
  client.provider.on('stateless', ({ payload }: { payload: string }) => {
    received.push(payload)
  })
  return received
}

/** Vrai dès que le serveur a fermé la connexion du client au document. */
export function closedFlag(client: Client): () => boolean {
  let closed = false
  client.provider.on('close', () => {
    closed = true
  })
  return () => closed
}

export const settle = (ms = 300) => new Promise((resolve) => setTimeout(resolve, ms))
