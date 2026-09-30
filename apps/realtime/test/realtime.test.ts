import { createHash } from 'node:crypto'
import { HocuspocusProvider, HocuspocusProviderWebsocket } from '@hocuspocus/provider'
import { documentName } from '@kaxolax/collab'
import { closeDocumentResponseSchema, projectSnapshotSchema } from '@kaxolax/contracts'
import type pg from 'pg'
import { WebSocket } from 'ws'
import * as Y from 'yjs'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import type { DocumentStore } from '../src/store.js'
import {
  type Client,
  connect,
  eventually,
  INTERNAL_TOKEN,
  openPool,
  openStore,
  type RealtimeServer,
  seedProject,
  startServer,
  tokenFor,
} from './helpers.js'

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex')

let store: DocumentStore
let pool: pg.Pool
let running: { server: RealtimeServer; url: string; httpUrl: string }
const clients: Client[] = []

function track(client: Client): Client {
  clients.push(client)
  return client
}

async function storedDocument(documentId: string) {
  const result = await pool.query<{ content_sha256: string | null; yjs_state: Buffer }>(
    'SELECT content_sha256, yjs_state FROM documents WHERE id = $1',
    [documentId],
  )
  return result.rows[0]
}

beforeAll(async () => {
  store = openStore()
  pool = openPool()
  running = await startServer(store)
})

afterEach(() => {
  for (const client of clients.splice(0)) client.destroy()
})

afterAll(async () => {
  await running.server.destroy()
  await store.close()
  await pool.end()
})

describe('collaborative editing', () => {
  it('synchronises two tabs of the same document in both directions', async () => {
    const seed = await seedProject(pool, 'Bonjour')
    const token = tokenFor(seed.owner, seed.projectId)
    const first = track(connect(running.url, seed.projectId, seed.documentId, token))
    const second = track(connect(running.url, seed.projectId, seed.documentId, token))
    await Promise.all([first.ready, second.ready])
    expect(first.text.toJSON()).toBe('Bonjour')

    first.text.insert(7, ' le monde')
    await eventually(() => second.text.toJSON() === 'Bonjour le monde')
    second.text.insert(0, '% ')
    await eventually(() => first.text.toJSON() === '% Bonjour le monde')
  })

  it('stores edits after the debounce and updates the project date', async () => {
    const seed = await seedProject(pool, 'v1')
    const client = track(
      connect(running.url, seed.projectId, seed.documentId, tokenFor(seed.owner, seed.projectId)),
    )
    await client.ready
    client.text.insert(2, ' puis v2')

    await eventually(
      async () => (await storedDocument(seed.documentId))?.content_sha256 === sha256('v1 puis v2'),
    )
    const project = await pool.query<{ fresh: boolean }>(
      `SELECT updated_at > now() - interval '1 minute' AS fresh FROM projects WHERE id = $1`,
      [seed.projectId],
    )
    expect(project.rows[0]?.fresh).toBe(true)
  })

  it('writes pending edits on shutdown and restores them after a restart', async () => {
    const seed = await seedProject(pool, 'avant')
    const token = tokenFor(seed.owner, seed.projectId)
    // Écriture différée d'une minute : seul l'arrêt propre peut l'avoir déclenchée.
    const slow = await startServer(store, 60_000)
    const client = track(connect(slow.url, seed.projectId, seed.documentId, token))
    await client.ready
    client.text.insert(5, ' redémarrage')
    await eventually(
      () => slow.server.hocuspocus.documents.size === 1 && client.provider.unsyncedChanges === 0,
    )
    expect((await storedDocument(seed.documentId))?.content_sha256).toBeNull()

    await slow.server.destroy()
    expect((await storedDocument(seed.documentId))?.content_sha256).toBe(
      sha256('avant redémarrage'),
    )

    const restarted = await startServer(store)
    try {
      const reopened = track(connect(restarted.url, seed.projectId, seed.documentId, token))
      await reopened.ready
      expect(reopened.text.toJSON()).toBe('avant redémarrage')
    } finally {
      for (const open of clients.splice(0)) open.destroy()
      await restarted.server.destroy()
    }
  })

  it('gives viewers and reviewers a read-only connection', async () => {
    const seed = await seedProject(pool, 'lecture seule')
    const viewer = await seed.addMember('viewer')
    const reviewer = await seed.addMember('reviewer')
    const editor = await seed.addMember('editor')
    const owner = track(
      connect(running.url, seed.projectId, seed.documentId, tokenFor(seed.owner, seed.projectId)),
    )
    const readers = [viewer, reviewer].map((id) =>
      track(
        connect(
          running.url,
          seed.projectId,
          seed.documentId,
          tokenFor(id, seed.projectId, { role: 'editor' }),
        ),
      ),
    )
    const writer = track(
      connect(
        running.url,
        seed.projectId,
        seed.documentId,
        tokenFor(editor, seed.projectId, { role: 'editor' }),
      ),
    )
    await Promise.all([owner.ready, writer.ready, ...readers.map((reader) => reader.ready)])

    // Le rôle vient de la base, pas du jeton : ces modifications sont ignorées par le serveur.
    for (const reader of readers) reader.text.insert(0, 'X')
    writer.text.insert(0, '>')
    await eventually(() => owner.text.toJSON() === '>lecture seule')
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(owner.text.toJSON()).toBe('>lecture seule')
    await eventually(
      async () =>
        (await storedDocument(seed.documentId))?.content_sha256 === sha256('>lecture seule'),
    )
  })
  it('keeps a document writable when it is closed and reopened at once on a shared socket', async () => {
    // Cas du navigateur : un onglet change de document puis y revient, ou React monte deux fois
    // l'éditeur. Sans routage par session, le serveur ignore les frappes du second fournisseur.
    const seed = await seedProject(pool, 'x')
    const socket = new HocuspocusProviderWebsocket({
      url: running.url,
      WebSocketPolyfill: WebSocket,
    })
    const open = () => {
      const doc = new Y.Doc()
      const provider = new HocuspocusProvider({
        websocketProvider: socket,
        name: documentName(seed.projectId, seed.documentId),
        token: tokenFor(seed.owner, seed.projectId),
        document: doc,
        sessionAwareness: true,
      })
      provider.attach()
      return { doc, provider }
    }
    try {
      open().provider.destroy()
      const second = open()
      await new Promise<void>((resolve) => {
        second.provider.on('synced', () => {
          resolve()
        })
      })
      second.doc.getText('content').insert(1, ' saved')
      await eventually(() => !second.provider.hasUnsyncedChanges)
      await eventually(
        async () => (await storedDocument(seed.documentId))?.content_sha256 === sha256('x saved'),
      )
      second.provider.destroy()
    } finally {
      socket.destroy()
    }
  })
})

describe('authentication', () => {
  it('refuses invalid, expired, foreign and mismatched tokens', async () => {
    const seed = await seedProject(pool)
    const other = await seedProject(pool)
    const stranger = await seed.addUser()
    const refused = [
      // Signature d'un autre secret.
      connect(
        running.url,
        seed.projectId,
        seed.documentId,
        tokenFor(seed.owner, seed.projectId, { secret: 'x'.repeat(40) }),
      ),
      // Jeton expiré.
      connect(
        running.url,
        seed.projectId,
        seed.documentId,
        tokenFor(seed.owner, seed.projectId, { expiresIn: -1 }),
      ),
      // Utilisateur qui n'est pas membre du projet.
      connect(running.url, seed.projectId, seed.documentId, tokenFor(stranger, seed.projectId)),
      // Jeton d'un autre projet que celui du document.
      connect(running.url, seed.projectId, seed.documentId, tokenFor(other.owner, other.projectId)),
      // Document d'un autre projet, avec un jeton valide pour le projet demandé.
      connect(running.url, seed.projectId, other.documentId, tokenFor(seed.owner, seed.projectId)),
      // Jeton illisible.
      connect(running.url, seed.projectId, seed.documentId, 'not-a-token'),
    ].map(track)
    for (const client of refused) {
      await expect(client.ready).rejects.toThrow('authentication failed')
      expect(client.text.toJSON()).toBe('')
    }
  })
})

describe('internal routes', () => {
  const internal = (path: string, init: RequestInit = {}, token: string | null = INTERNAL_TOKEN) =>
    fetch(`${running.httpUrl}${path}`, {
      ...init,
      headers: token === null ? {} : { 'x-internal-token': token },
    })

  it('answers the health check and refuses internal calls without the right token', async () => {
    const health = await fetch(`${running.httpUrl}/health`)
    expect(health.status).toBe(200)
    expect(await health.json()).toMatchObject({ status: 'ok' })

    const seed = await seedProject(pool)
    const path = `/internal/projects/${seed.projectId}/snapshot`
    expect((await internal(path, {}, null)).status).toBe(401)
    expect((await internal(path, {}, 'wrong-token-wrong-token-wrong-token')).status).toBe(401)
    expect((await internal('/internal/unknown')).status).toBe(404)
    expect((await fetch(`${running.httpUrl}/`)).status).toBe(404)
  })

  it('returns a snapshot with unsaved edits of open documents and stored content of the others', async () => {
    const seed = await seedProject(pool, 'ouvert')
    const closedId = await seed.addDocument('fermé')
    const client = track(
      connect(running.url, seed.projectId, seed.documentId, tokenFor(seed.owner, seed.projectId)),
    )
    await client.ready
    client.text.insert(6, ' et modifié')
    await eventually(async () => {
      const response = await internal(`/internal/projects/${seed.projectId}/snapshot`)
      const snapshot = projectSnapshotSchema.parse(await response.json())
      return (
        snapshot.documents.find((document) => document.id === seed.documentId)?.content ===
        'ouvert et modifié'
      )
    })

    const response = await internal(`/internal/projects/${seed.projectId}/snapshot`)
    const snapshot = projectSnapshotSchema.parse(await response.json())
    expect(snapshot.projectId).toBe(seed.projectId)
    expect(snapshot.documents).toHaveLength(2)
    expect(snapshot.documents).toContainEqual({
      id: closedId,
      content: 'fermé',
      sha256: sha256('fermé'),
    })
    expect(snapshot.documents).toContainEqual({
      id: seed.documentId,
      content: 'ouvert et modifié',
      sha256: sha256('ouvert et modifié'),
    })
    // Le document fermé a été chargé le temps de la lecture, puis déchargé.
    const documents = running.server.hocuspocus.documents
    await eventually(() => !documents.has(documentName(seed.projectId, closedId)))
    expect(documents.has(documentName(seed.projectId, seed.documentId))).toBe(true)
  })

  it('closes the connections of a deleted document and refuses to reopen it', async () => {
    const seed = await seedProject(pool)
    const token = tokenFor(seed.owner, seed.projectId)
    const client = track(connect(running.url, seed.projectId, seed.documentId, token))
    await client.ready
    let closedByServer = false
    client.provider.on('close', () => {
      closedByServer = true
    })

    await pool.query('DELETE FROM documents WHERE id = $1', [seed.documentId])
    const response = await internal(`/internal/documents/${seed.documentId}/close`, {
      method: 'POST',
    })
    expect(response.status).toBe(200)
    expect(closeDocumentResponseSchema.parse(await response.json())).toEqual({ closed: true })
    await eventually(() => closedByServer)

    const again = await internal(`/internal/documents/${seed.documentId}/close`, { method: 'POST' })
    expect(closeDocumentResponseSchema.parse(await again.json())).toEqual({ closed: false })
    const reopened = track(connect(running.url, seed.projectId, seed.documentId, token))
    await expect(reopened.ready).rejects.toThrow('authentication failed')
  })
})
