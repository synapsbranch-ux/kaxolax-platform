import { randomUUID } from 'node:crypto'
import { replaceDocumentResponseSchema } from '@kaxolax/contracts'
import type pg from 'pg'
import * as Y from 'yjs'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import type { DocumentStore } from '../src/store.js'
import {
  type Client,
  connect,
  eventually,
  internalPost,
  openPool,
  openStore,
  type RealtimeServer,
  seedProject,
  settle,
  startServer,
  tokenFor,
} from './helpers.js'

/**
 * Historique (tâche 8) : le service journalise l'origine de chaque mise à jour Yjs appliquée
 * (table document_updates), une seule fois même avec plusieurs instances, et remplace le texte
 * d'un document pour une restauration.
 */

const REDIS_URL = process.env.REALTIME_TEST_REDIS_URL ?? 'redis://127.0.0.1:6379'

let store: DocumentStore
let pool: pg.Pool
let single: { server: RealtimeServer; url: string; httpUrl: string }
let a: { server: RealtimeServer; url: string; httpUrl: string }
let b: { server: RealtimeServer; url: string; httpUrl: string }
const clients: Client[] = []

function track(client: Client): Client {
  clients.push(client)
  return client
}

interface LoggedUpdate {
  user_id: string | null
  yjs_update: Buffer
}

async function loggedUpdates(documentId: string): Promise<LoggedUpdate[]> {
  const result = await pool.query<LoggedUpdate>(
    'SELECT user_id, yjs_update FROM document_updates WHERE document_id = $1 ORDER BY id',
    [documentId],
  )
  return result.rows
}

/** Texte inséré par une mise à jour journalisée (contenu de ses structures). */
function insertedText(update: Buffer): string {
  return Y.decodeUpdate(new Uint8Array(update))
    .structs.map((struct) =>
      struct instanceof Y.Item && struct.content instanceof Y.ContentString
        ? struct.content.str
        : '',
    )
    .join('')
}

beforeAll(async () => {
  store = openStore()
  pool = openPool()
  single = await startServer(store)
  const redis = { REDIS_URL, REDIS_PREFIX: `kaxolax-realtime-test-${randomUUID()}` }
  a = await startServer(store, 50, {}, redis)
  b = await startServer(store, 50, {}, redis)
})

afterEach(() => {
  for (const client of clients.splice(0)) client.destroy()
})

afterAll(async () => {
  await Promise.all([single.server.destroy(), a.server.destroy(), b.server.destroy()])
  await store.close()
  await pool.end()
})

describe('update origins', () => {
  it('records each applied update with the account that sent it, never a refused one', async () => {
    const seed = await seedProject(pool, 'Bonjour')
    const editor = await seed.addMember('editor')
    const reviewer = await seed.addMember('reviewer')
    const owner = track(
      connect(single.url, seed.projectId, seed.documentId, tokenFor(seed.owner, seed.projectId)),
    )
    const writer = track(
      connect(
        single.url,
        seed.projectId,
        seed.documentId,
        tokenFor(editor, seed.projectId, { role: 'editor' }),
      ),
    )
    const reader = track(
      connect(
        single.url,
        seed.projectId,
        seed.documentId,
        tokenFor(reviewer, seed.projectId, { role: 'reviewer' }),
      ),
    )
    await Promise.all([owner.ready, writer.ready, reader.ready])

    owner.text.insert(7, ' Ada')
    await eventually(() => writer.text.toJSON() === 'Bonjour Ada')
    writer.text.insert(0, 'Bob: ')
    await eventually(() => owner.text.toJSON() === 'Bob: Bonjour Ada')
    // Lecture seule : rejetée par le serveur, donc absente du journal.
    reader.text.insert(0, 'Intrus ')
    await settle()

    await eventually(async () => (await loggedUpdates(seed.documentId)).length === 2)
    const rows = await loggedUpdates(seed.documentId)
    expect(rows.map((row) => row.user_id)).toEqual([seed.owner, editor])
    expect(rows.map((row) => insertedText(row.yjs_update))).toEqual([' Ada', 'Bob: '])
    // La simple ouverture d'un document (chargement, synchronisation) n'est pas journalisée.
    expect(rows.some((row) => insertedText(row.yjs_update).includes('Bonjour'))).toBe(false)
  })

  it('merges consecutive updates of one author and keeps the order between authors', async () => {
    const seed = await seedProject(pool, '')
    const editor = await seed.addMember('editor')
    const owner = track(
      connect(single.url, seed.projectId, seed.documentId, tokenFor(seed.owner, seed.projectId)),
    )
    const writer = track(
      connect(
        single.url,
        seed.projectId,
        seed.documentId,
        tokenFor(editor, seed.projectId, { role: 'editor' }),
      ),
    )
    await Promise.all([owner.ready, writer.ready])

    for (const letter of ['a', 'b', 'c']) owner.text.insert(owner.text.length, letter)
    await eventually(() => writer.text.toJSON() === 'abc')
    writer.text.insert(3, 'd')
    await eventually(() => owner.text.toJSON() === 'abcd')
    // Écrit à la demande (avant une version de compilation ou de restauration).
    const flushed = await internalPost(
      single.httpUrl,
      `/internal/projects/${seed.projectId}/updates/flush`,
    )
    expect(flushed.status).toBe(200)

    await eventually(async () => {
      const rows = await loggedUpdates(seed.documentId)
      return rows.map((row) => insertedText(row.yjs_update)).join('') === 'abcd'
    })
    const rows = await loggedUpdates(seed.documentId)
    expect(rows.at(-1)?.user_id).toBe(editor)
    expect(new Set(rows.slice(0, -1).map((row) => row.user_id))).toEqual(new Set([seed.owner]))
    expect(rows.length).toBeLessThanOrEqual(4)
  })

  it('records an update once with two instances behind Redis, by the instance that received it', async () => {
    const seed = await seedProject(pool, 'Texte')
    const editor = await seed.addMember('editor')
    const onA = track(
      connect(a.url, seed.projectId, seed.documentId, tokenFor(seed.owner, seed.projectId)),
    )
    const onB = track(
      connect(
        b.url,
        seed.projectId,
        seed.documentId,
        tokenFor(editor, seed.projectId, { role: 'editor' }),
      ),
    )
    await Promise.all([onA.ready, onB.ready])

    onA.text.insert(5, ' A')
    await eventually(() => onB.text.toJSON() === 'Texte A')
    onB.text.insert(0, 'B ')
    await eventually(() => onA.text.toJSON() === 'B Texte A')
    await settle()

    await eventually(async () => (await loggedUpdates(seed.documentId)).length >= 2)
    await settle()
    const rows = await loggedUpdates(seed.documentId)
    expect(rows.map((row) => [row.user_id, insertedText(row.yjs_update)])).toEqual([
      [seed.owner, ' A'],
      [editor, 'B '],
    ])
  })
})

describe('flush across instances', () => {
  it('returns once every instance has written its pending updates', async () => {
    // Écriture par lots désactivée en pratique : seule la demande explicite écrit le journal.
    const redis = { REDIS_URL, REDIS_PREFIX: `kaxolax-realtime-test-${randomUUID()}` }
    const slow = { HISTORY_FLUSH_MS: 600_000 }
    const first = await startServer(store, 50, {}, redis, slow)
    const second = await startServer(store, 50, {}, redis, slow)
    try {
      const seed = await seedProject(pool, 'Texte')
      const editor = await seed.addMember('editor')
      const onFirst = track(
        connect(first.url, seed.projectId, seed.documentId, tokenFor(seed.owner, seed.projectId)),
      )
      const onSecond = track(
        connect(
          second.url,
          seed.projectId,
          seed.documentId,
          tokenFor(editor, seed.projectId, { role: 'editor' }),
        ),
      )
      await Promise.all([onFirst.ready, onSecond.ready])
      onSecond.text.insert(0, 'B ')
      await eventually(() => onFirst.text.toJSON() === 'B Texte')
      await settle()
      expect(await loggedUpdates(seed.documentId)).toHaveLength(0)

      // Demandée à l'instance qui n'a pas reçu la frappe : écrite par l'autre avant la réponse.
      const flushed = await internalPost(
        first.httpUrl,
        `/internal/projects/${seed.projectId}/updates/flush`,
      )
      expect(flushed.status).toBe(200)
      const rows = await loggedUpdates(seed.documentId)
      expect(rows.map((row) => [row.user_id, insertedText(row.yjs_update)])).toEqual([
        [editor, 'B '],
      ])
    } finally {
      await Promise.all([first.server.destroy(), second.server.destroy()])
    }
  })
})

describe('text replacement (restore)', () => {
  it('replaces the text minimally, reaches connected clients and records the restorer', async () => {
    const seed = await seedProject(pool, 'Bonjour le monde')
    const editor = await seed.addMember('editor')
    const watcher = track(
      connect(single.url, seed.projectId, seed.documentId, tokenFor(seed.owner, seed.projectId)),
    )
    await watcher.ready

    const response = await internalPost(
      single.httpUrl,
      `/internal/projects/${seed.projectId}/documents/${seed.documentId}/replace`,
      { content: 'Bonjour à tous', userId: editor },
    )
    expect(response.status).toBe(200)
    expect(replaceDocumentResponseSchema.parse(await response.json())).toEqual({ changed: true })
    await eventually(() => watcher.text.toJSON() === 'Bonjour à tous')

    await eventually(async () => (await loggedUpdates(seed.documentId)).length === 1)
    const [row] = await loggedUpdates(seed.documentId)
    expect(row?.user_id).toBe(editor)
    expect(insertedText(row?.yjs_update ?? Buffer.alloc(0))).toBe('à tous')

    const again = await internalPost(
      single.httpUrl,
      `/internal/projects/${seed.projectId}/documents/${seed.documentId}/replace`,
      { content: 'Bonjour à tous', userId: editor },
    )
    expect(await again.json()).toEqual({ changed: false })
  })

  it('appends a block once, keeping the text typed meanwhile', async () => {
    const seed = await seedProject(pool, '@a{x,}\n')
    const editor = await seed.addMember('editor')
    const watcher = track(
      connect(single.url, seed.projectId, seed.documentId, tokenFor(seed.owner, seed.projectId)),
    )
    const typist = track(
      connect(
        single.url,
        seed.projectId,
        seed.documentId,
        tokenFor(editor, seed.projectId, { role: 'editor' }),
      ),
    )
    await Promise.all([watcher.ready, typist.ready])
    // Frappe reçue par le serveur (et relayée) avant l'ajout.
    typist.text.insert(0, '% note\n')
    await eventually(() => watcher.text.toJSON().startsWith('% note'))
    const append = () =>
      internalPost(
        single.httpUrl,
        `/internal/projects/${seed.projectId}/documents/${seed.documentId}/replace`,
        { content: '@b{y,}', userId: editor, append: true },
      )
    const response = await append()
    expect(response.status).toBe(200)
    expect(replaceDocumentResponseSchema.parse(await response.json())).toEqual({ changed: true })
    await eventually(() => watcher.text.toJSON() === '% note\n@a{x,}\n\n@b{y,}\n')
    expect(await (await append()).json()).toEqual({ changed: false })
  })

  it('replaces a document no one has open and stores it', async () => {
    const seed = await seedProject(pool, 'ancien')
    const response = await internalPost(
      single.httpUrl,
      `/internal/projects/${seed.projectId}/documents/${seed.documentId}/replace`,
      { content: 'nouveau', userId: seed.owner },
    )
    expect(response.status).toBe(200)
    await eventually(async () => {
      const stored = await store.fetchState(seed.projectId, seed.documentId)
      const doc = new Y.Doc()
      if (stored) Y.applyUpdate(doc, stored)
      return doc.getText('content').toJSON() === 'nouveau'
    })
  })

  it('refuses an unknown document or an invalid body', async () => {
    const seed = await seedProject(pool)
    const unknown = await internalPost(
      single.httpUrl,
      `/internal/projects/${seed.projectId}/documents/${randomUUID()}/replace`,
      { content: 'x', userId: seed.owner },
    )
    expect(unknown.status).toBe(404)
    const invalid = await internalPost(
      single.httpUrl,
      `/internal/projects/${seed.projectId}/documents/${seed.documentId}/replace`,
      { content: 42 },
    )
    expect(invalid.status).toBe(400)
  })
})
