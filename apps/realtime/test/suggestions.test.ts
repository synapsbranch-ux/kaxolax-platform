import { randomUUID } from 'node:crypto'
import {
  anchorToBase64,
  APPLIED_SUGGESTIONS_FIELD,
  createCommentAnchor,
  createPointAnchor,
} from '@kaxolax/collab'
import {
  appliedSuggestionsResponseSchema,
  type ApplySuggestionsRequest,
  applySuggestionsResponseSchema,
} from '@kaxolax/contracts'
import type pg from 'pg'
import * as Y from 'yjs'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import type { ClusterBus } from '../src/cluster.js'
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
  startServer,
  tokenFor,
} from './helpers.js'

/**
 * Suivi des modifications : le service applique les suggestions acceptées au document en cours
 * d'édition, au nom de leur auteur dans le journal de l'historique, une seule fois, et refuse
 * d'appliquer une suggestion dont le texte d'origine a changé.
 */

const REDIS_URL = process.env.REALTIME_TEST_REDIS_URL ?? 'redis://127.0.0.1:6379'

let store: DocumentStore
let pool: pg.Pool
let single: { server: RealtimeServer; url: string; httpUrl: string }
let a: { server: RealtimeServer; url: string; httpUrl: string }
let b: { server: RealtimeServer; url: string; httpUrl: string }
/** Instance dont une autre instance (annoncée par le bus) ne répond jamais. */
let lonely: { server: RealtimeServer; url: string; httpUrl: string }
const clients: Client[] = []

function track(client: Client): Client {
  clients.push(client)
  return client
}

beforeAll(async () => {
  store = openStore()
  pool = openPool()
  single = await startServer(store)
  const redis = { REDIS_URL, REDIS_PREFIX: `kaxolax-realtime-test-${randomUUID()}` }
  a = await startServer(store, 50, {}, redis)
  b = await startServer(store, 50, {}, redis)
  const silentPeer: ClusterBus = {
    publish: () => Promise.resolve(),
    publishCounted: () => Promise.resolve(1),
    subscribe: () => undefined,
    ready: () => Promise.resolve(),
    close: () => Promise.resolve(),
  }
  lonely = await startServer(store, 50, {}, {}, {}, { bus: silentPeer })
})

afterEach(() => {
  for (const client of clients.splice(0)) client.destroy()
})

afterAll(async () => {
  await Promise.all([
    single.server.destroy(),
    a.server.destroy(),
    b.server.destroy(),
    lonely.server.destroy(),
  ])
  await store.close()
  await pool.end()
})

async function loggedAuthors(documentId: string): Promise<(string | null)[]> {
  const result = await pool.query<{ user_id: string | null }>(
    'SELECT user_id FROM document_updates WHERE document_id = $1 ORDER BY id',
    [documentId],
  )
  return result.rows.map((row) => row.user_id)
}

type Suggestion = ApplySuggestionsRequest['suggestions'][number]

/** Suggestion de remplacement de `original` (première occurrence) dans le texte du client. */
function replacing(client: Client, authorId: string, original: string, proposed: string) {
  const from = client.text.toJSON().indexOf(original)
  return {
    id: randomUUID(),
    authorId,
    kind: 'replace',
    anchor: anchorToBase64(createCommentAnchor(client.text, from, from + original.length)),
    originalText: original,
    proposedText: proposed,
  } satisfies Suggestion
}

function apply(base: string, projectId: string, documentId: string, body: unknown) {
  return internalPost(
    base,
    `/internal/projects/${projectId}/documents/${documentId}/suggestions/apply`,
    body,
  )
}

function applied(base: string, projectId: string, documentId: string, ids: string[]) {
  return internalPost(
    base,
    `/internal/projects/${projectId}/documents/${documentId}/suggestions/applied`,
    { ids },
  )
}

describe('accepted suggestions', () => {
  it('applies them once, for connected clients, in the name of their author', async () => {
    const seed = await seedProject(pool, 'Le chien dort.')
    const reviewer = await seed.addMember('reviewer')
    const editor = await seed.addMember('editor')
    const watcher = track(
      connect(
        single.url,
        seed.projectId,
        seed.documentId,
        tokenFor(reviewer, seed.projectId, { role: 'reviewer' }),
      ),
    )
    await watcher.ready
    const replace = replacing(watcher, reviewer, 'chien', 'chat')
    const insert = {
      id: randomUUID(),
      authorId: seed.owner,
      kind: 'insert',
      anchor: anchorToBase64(createPointAnchor(watcher.text, 'Le chien'.length)),
      originalText: '',
      proposedText: ' noir',
    } satisfies Suggestion
    const body = { decidedBy: editor, suggestions: [replace, insert] }

    const response = await apply(single.httpUrl, seed.projectId, seed.documentId, body)
    expect(response.status).toBe(200)
    expect(applySuggestionsResponseSchema.parse(await response.json())).toEqual({
      results: [
        { id: replace.id, outcome: 'applied' },
        { id: insert.id, outcome: 'applied' },
      ],
    })
    await eventually(() => watcher.text.toJSON() === 'Le chat noir dort.')
    expect(watcher.doc.getMap(APPLIED_SUGGESTIONS_FIELD).get(replace.id)).toBe(editor)

    // Chaque modification est attribuée à l'auteur de sa suggestion, pas au décideur.
    await eventually(async () => (await loggedAuthors(seed.documentId)).length === 2)
    expect(await loggedAuthors(seed.documentId)).toEqual([reviewer, seed.owner])

    // Réponse perdue, appel répété : rien n'est appliqué deux fois.
    const again = await apply(single.httpUrl, seed.projectId, seed.documentId, body)
    expect(await again.json()).toEqual({
      results: [
        { id: replace.id, outcome: 'already-applied' },
        { id: insert.id, outcome: 'already-applied' },
      ],
    })
    await eventually(async () => {
      const stored = await store.fetchState(seed.projectId, seed.documentId)
      const doc = new Y.Doc()
      if (stored) Y.applyUpdate(doc, stored)
      return doc.getText('content').toJSON() === 'Le chat noir dort.'
    })
    expect(watcher.text.toJSON()).toBe('Le chat noir dort.')
    expect(await loggedAuthors(seed.documentId)).toHaveLength(2)
  })

  it('does not apply a suggestion whose original text changed', async () => {
    const seed = await seedProject(pool, 'Le chien dort.')
    const writer = track(
      connect(single.url, seed.projectId, seed.documentId, tokenFor(seed.owner, seed.projectId)),
    )
    await writer.ready
    const suggestion = replacing(writer, seed.owner, 'chien', 'chat')
    writer.text.insert(writer.text.toJSON().indexOf('ien'), 'u')
    await eventually(async () => (await loggedAuthors(seed.documentId)).length === 1)

    const response = await apply(single.httpUrl, seed.projectId, seed.documentId, {
      decidedBy: seed.owner,
      suggestions: [suggestion],
    })
    expect(await response.json()).toEqual({ results: [{ id: suggestion.id, outcome: 'stale' }] })
    expect(writer.text.toJSON()).toBe('Le chuien dort.')
  })

  it('applies a suggestion anchored in text typed on another instance', async () => {
    const seed = await seedProject(pool, 'Bonjour')
    const writer = track(
      connect(b.url, seed.projectId, seed.documentId, tokenFor(seed.owner, seed.projectId)),
    )
    const watcher = track(
      connect(a.url, seed.projectId, seed.documentId, tokenFor(seed.owner, seed.projectId)),
    )
    await Promise.all([writer.ready, watcher.ready])
    writer.text.insert(7, ' le monde')
    const suggestion = replacing(writer, seed.owner, 'monde', 'ciel')
    // Texte reçu par l'instance `b` (comme avant toute création de suggestion par l'API) ; `a`
    // doit encore rattraper sa copie.
    await eventually(() => !writer.provider.hasUnsyncedChanges)

    const response = await apply(a.httpUrl, seed.projectId, seed.documentId, {
      decidedBy: seed.owner,
      suggestions: [suggestion],
    })
    expect(await response.json()).toEqual({ results: [{ id: suggestion.id, outcome: 'applied' }] })
    await eventually(() => writer.text.toJSON() === 'Bonjour le ciel')
    await eventually(() => watcher.text.toJSON() === 'Bonjour le ciel')
  })

  it('refuses a decider who cannot decide, an unknown document or an invalid body', async () => {
    const seed = await seedProject(pool, 'abc')
    const reviewer = await seed.addMember('reviewer')
    const outsider = await seed.addUser()
    const elsewhere = new Y.Doc().getText('content')
    elsewhere.insert(0, 'abc')
    const suggestion = {
      id: randomUUID(),
      authorId: reviewer,
      kind: 'insert',
      anchor: anchorToBase64(createPointAnchor(elsewhere, 1)),
      originalText: '',
      proposedText: 'x',
    } satisfies Suggestion
    for (const decidedBy of [reviewer, outsider]) {
      const refused = await apply(single.httpUrl, seed.projectId, seed.documentId, {
        decidedBy,
        suggestions: [suggestion],
      })
      expect(refused.status).toBe(403)
    }
    const unknown = await apply(single.httpUrl, seed.projectId, randomUUID(), {
      decidedBy: seed.owner,
      suggestions: [suggestion],
    })
    expect(unknown.status).toBe(404)
    const invalid = await apply(single.httpUrl, seed.projectId, seed.documentId, {
      decidedBy: seed.owner,
      suggestions: [],
    })
    expect(invalid.status).toBe(400)
    // Ancre d'un autre document : obsolète, rien n'est appliqué.
    const foreign = await apply(single.httpUrl, seed.projectId, seed.documentId, {
      decidedBy: seed.owner,
      suggestions: [suggestion],
    })
    expect(await foreign.json()).toEqual({ results: [{ id: suggestion.id, outcome: 'stale' }] })
  })

  it('applies nothing while another instance has not described its documents', async () => {
    const seed = await seedProject(pool, 'Le chien dort.')
    const writer = track(
      connect(lonely.url, seed.projectId, seed.documentId, tokenFor(seed.owner, seed.projectId)),
    )
    await writer.ready
    const suggestion = replacing(writer, seed.owner, 'chien', 'chat')

    const response = await apply(lonely.httpUrl, seed.projectId, seed.documentId, {
      decidedBy: seed.owner,
      suggestions: [suggestion],
    })
    // Rattrapage incomplet : ni obsolète à tort, ni appliquée deux fois ; l'API réessaiera.
    expect(response.status).toBe(503)
    expect(writer.text.toJSON()).toBe('Le chien dort.')
    expect(writer.doc.getMap(APPLIED_SUGGESTIONS_FIELD).size).toBe(0)
    const check = await applied(lonely.httpUrl, seed.projectId, seed.documentId, [suggestion.id])
    expect(check.status).toBe(503)
  })
})

describe('applied suggestions', () => {
  it('tells which suggestions are already in the document, across instances', async () => {
    const seed = await seedProject(pool, 'Le chien dort.')
    const writer = track(
      connect(b.url, seed.projectId, seed.documentId, tokenFor(seed.owner, seed.projectId)),
    )
    await writer.ready
    const done = replacing(writer, seed.owner, 'chien', 'chat')
    const pending = replacing(writer, seed.owner, 'dort', 'court')
    const response = await apply(b.httpUrl, seed.projectId, seed.documentId, {
      decidedBy: seed.owner,
      suggestions: [done],
    })
    expect(response.status).toBe(200)

    // Demandé à l'autre instance : elle rattrape la copie de `b` avant de lire.
    const check = await applied(a.httpUrl, seed.projectId, seed.documentId, [done.id, pending.id])
    expect(check.status).toBe(200)
    expect(appliedSuggestionsResponseSchema.parse(await check.json())).toEqual({
      applied: [{ id: done.id, decidedBy: seed.owner }],
    })
    const unknown = await applied(a.httpUrl, seed.projectId, randomUUID(), [done.id])
    expect(unknown.status).toBe(404)
    const invalid = await applied(a.httpUrl, seed.projectId, seed.documentId, [])
    expect(invalid.status).toBe(400)
  })

  it('reverts what a client writes to the applied suggestions, on every instance', async () => {
    const seed = await seedProject(pool, 'Le chien dort.')
    const editor = await seed.addMember('editor')
    const outsider = await seed.addUser()
    const forger = track(
      connect(
        a.url,
        seed.projectId,
        seed.documentId,
        tokenFor(editor, seed.projectId, { role: 'editor' }),
      ),
    )
    const watcher = track(
      connect(b.url, seed.projectId, seed.documentId, tokenFor(seed.owner, seed.projectId)),
    )
    await Promise.all([forger.ready, watcher.ready])
    const done = replacing(forger, seed.owner, 'chien', 'chat')
    const pending = replacing(forger, seed.owner, 'dort', 'court')
    const response = await apply(a.httpUrl, seed.projectId, seed.documentId, {
      decidedBy: seed.owner,
      suggestions: [done],
    })
    expect(response.status).toBe(200)
    await eventually(() => forger.doc.getMap(APPLIED_SUGGESTIONS_FIELD).get(done.id) === seed.owner)

    // Le client marque une suggestion appliquée, change un décideur et en efface un autre.
    const map = forger.doc.getMap<string>(APPLIED_SUGGESTIONS_FIELD)
    map.set(pending.id, outsider)
    map.set(done.id, outsider)
    await eventually(() => map.get(done.id) === seed.owner && !map.has(pending.id))
    map.delete(done.id)
    await eventually(() => map.get(done.id) === seed.owner)
    const watched = watcher.doc.getMap<string>(APPLIED_SUGGESTIONS_FIELD)
    await eventually(() => watched.get(done.id) === seed.owner && !watched.has(pending.id))

    for (const base of [a.httpUrl, b.httpUrl]) {
      const check = await applied(base, seed.projectId, seed.documentId, [done.id, pending.id])
      expect(appliedSuggestionsResponseSchema.parse(await check.json())).toEqual({
        applied: [{ id: done.id, decidedBy: seed.owner }],
      })
    }
    // Le texte, lui, reste modifiable par l'éditeur.
    forger.text.insert(0, '% ')
    await eventually(() => watcher.text.toJSON() === '% Le chat dort.')
  })
})
