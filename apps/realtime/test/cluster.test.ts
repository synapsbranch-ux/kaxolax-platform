import { randomUUID } from 'node:crypto'
import {
  INTERNAL_TOKEN_HEADER,
  parsePresenceState,
  parseProjectEventMessage,
  presenceUserFor,
  type ProjectEvent,
  projectSnapshotSchema,
} from '@kaxolax/contracts'
import type pg from 'pg'
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate } from 'y-protocols/awareness'
import * as Y from 'yjs'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import type { DocumentStore } from '../src/store.js'
import {
  type Client,
  closedFlag,
  connect,
  connectMeta,
  connectUserChannel,
  eventually,
  INTERNAL_TOKEN,
  internalPost,
  openPool,
  openStore,
  type RealtimeServer,
  seedProject,
  settle,
  startServer,
  statelessMessages,
  tokenFor,
  userTokenFor,
} from './helpers.js'

/**
 * Deux instances du service derrière le même Redis (docker compose, 127.0.0.1:6379) : documents,
 * awareness, événements et fermetures de connexions passent de l'une à l'autre. Préfixe Redis
 * propre à chaque lancement : plusieurs suites peuvent partager le même Redis.
 */

const REDIS_URL = process.env.REALTIME_TEST_REDIS_URL ?? 'redis://127.0.0.1:6379'

let store: DocumentStore
let pool: pg.Pool
let a: { server: RealtimeServer; url: string; httpUrl: string }
let b: { server: RealtimeServer; url: string; httpUrl: string }
const clients: Client[] = []

function track(client: Client): Client {
  clients.push(client)
  return client
}

beforeAll(async () => {
  store = openStore()
  pool = openPool()
  const redis = { REDIS_URL, REDIS_PREFIX: `kaxolax-realtime-test-${randomUUID()}` }
  a = await startServer(store, 50, {}, redis)
  b = await startServer(store, 50, {}, redis)
})

afterEach(() => {
  for (const client of clients.splice(0)) client.destroy()
})

afterAll(async () => {
  await Promise.all([a.server.destroy(), b.server.destroy()])
  await store.close()
  await pool.end()
})

describe('two instances behind Redis', () => {
  it('synchronises an edit made on one instance with a client of the other', async () => {
    const seed = await seedProject(pool, 'Bonjour')
    const token = tokenFor(seed.owner, seed.projectId)
    const onA = track(connect(a.url, seed.projectId, seed.documentId, token))
    const onB = track(connect(b.url, seed.projectId, seed.documentId, token))
    await Promise.all([onA.ready, onB.ready])

    onA.text.insert(7, ' A')
    await eventually(() => onB.text.toJSON() === 'Bonjour A')
    onB.text.insert(0, 'B ')
    await eventually(() => onA.text.toJSON() === 'B Bonjour A')
  })

  it('shares awareness across instances with the identity imposed by the first one', async () => {
    const seed = await seedProject(pool)
    const editor = await seed.addMember('editor')
    const onA = track(
      connectMeta(a.url, seed.projectId, tokenFor(editor, seed.projectId, { role: 'editor' })),
    )
    const onB = track(connectMeta(b.url, seed.projectId, tokenFor(seed.owner, seed.projectId)))
    await Promise.all([onA.ready, onB.ready])

    onA.provider.setAwarenessField('user', { id: seed.owner, name: 'Faux' })
    onA.provider.setAwarenessField('documentId', seed.documentId)
    const state = () => onB.provider.awareness?.getStates().get(onA.doc.clientID) as unknown
    await eventually(() => parsePresenceState(state())?.documentId === seed.documentId)
    expect(parsePresenceState(state())?.user).toEqual(presenceUserFor(editor, null))
  })

  it.each([
    ['its last connection', false],
    ['one of its connections', true],
  ])(
    'removes the presence of a client that leaves instance A (%s) from instance B in less than 2 seconds',
    async (_label, otherStaysOnA) => {
      const seed = await seedProject(pool)
      const editor = await seed.addMember('editor')
      const leaving = track(
        connectMeta(a.url, seed.projectId, tokenFor(editor, seed.projectId, { role: 'editor' })),
      )
      const onB = track(connectMeta(b.url, seed.projectId, tokenFor(seed.owner, seed.projectId)))
      const others = otherStaysOnA
        ? [track(connectMeta(a.url, seed.projectId, tokenFor(seed.owner, seed.projectId)))]
        : []
      await Promise.all([leaving.ready, onB.ready, ...others.map((client) => client.ready)])
      const leavingId = leaving.doc.clientID
      leaving.provider.setAwarenessField('documentId', seed.documentId)
      await eventually(() => onB.provider.awareness?.getStates().has(leavingId) === true)

      const started = Date.now()
      leaving.destroy()
      await eventually(() => onB.provider.awareness?.getStates().has(leavingId) === false, 2_000)
      expect(Date.now() - started).toBeLessThan(2_000)
      for (const other of others) {
        await eventually(() => other.provider.awareness?.getStates().has(leavingId) === false)
      }
    },
  )

  it('keeps the presence of a client that reconnected to instance B when its old connection to A closes', async () => {
    const seed = await seedProject(pool)
    const editor = await seed.addMember('editor')
    const token = () => tokenFor(editor, seed.projectId, { role: 'editor' })
    const old = track(connectMeta(a.url, seed.projectId, token()))
    const watcher = track(connectMeta(b.url, seed.projectId, tokenFor(seed.owner, seed.projectId)))
    await Promise.all([old.ready, watcher.ready])
    const clientId = old.doc.clientID
    old.provider.setAwarenessField('documentId', seed.documentId)
    await eventually(() => watcher.provider.awareness?.getStates().has(clientId) === true)

    // Même client reconnecté sur B (même clientId) avant que A ne voie la fin de l'ancienne
    // connexion : B connaît encore l'état relayé par A, la reprise n'est qu'une mise à jour.
    const reconnected = track(connectMeta(b.url, seed.projectId, token(), { clientId }))
    await reconnected.ready
    reconnected.provider.setAwarenessField('documentId', seed.documentId)
    reconnected.provider.setAwarenessField('cursor', 'reconnected')
    await eventually(
      () => watcher.provider.awareness?.getStates().get(clientId)?.cursor === 'reconnected',
    )

    old.destroy()
    await settle(1_000)
    expect(watcher.provider.awareness?.getStates().get(clientId)?.cursor).toBe('reconnected')
  })

  it('refuses a clientId taken from a collaborator connected to the other instance', async () => {
    const seed = await seedProject(pool)
    const editor = await seed.addMember('editor')
    const viewer = await seed.addMember('viewer')
    const victim = track(
      connectMeta(b.url, seed.projectId, tokenFor(editor, seed.projectId, { role: 'editor' })),
    )
    const attacker = track(
      connectMeta(a.url, seed.projectId, tokenFor(viewer, seed.projectId, { role: 'viewer' })),
    )
    const watcher = track(connectMeta(a.url, seed.projectId, tokenFor(seed.owner, seed.projectId)))
    await Promise.all([victim.ready, attacker.ready, watcher.ready])
    const victimId = victim.doc.clientID
    victim.provider.setAwarenessField('documentId', seed.documentId)
    const seen = () => parsePresenceState(watcher.provider.awareness?.getStates().get(victimId))
    await eventually(() => seen()?.documentId === seed.documentId)
    await eventually(() => attacker.provider.awareness?.getStates().has(victimId) === true)

    // État forgé sur le clientId de la victime, avec une horloge très élevée, envoyé par le
    // fournisseur de l'attaquant comme une mise à jour de son awareness.
    const forged = new Awareness(new Y.Doc())
    forged.states.set(victimId, { documentId: null })
    forged.meta.set(victimId, { clock: 1_000_000, lastUpdated: Date.now() })
    const awareness = attacker.provider.awareness
    if (!awareness) throw new Error('attacker has no awareness')
    applyAwarenessUpdate(awareness, encodeAwarenessUpdate(forged, [victimId]), 'forged')
    forged.destroy()

    await new Promise((resolve) => setTimeout(resolve, 500))
    expect(seen()?.user.id).toBe(editor)
    expect(seen()?.documentId).toBe(seed.documentId)
    // Le départ de l'attaquant n'efface pas la présence de la victime.
    attacker.destroy()
    await new Promise((resolve) => setTimeout(resolve, 500))
    expect(seen()?.user.id).toBe(editor)
    expect(seen()?.documentId).toBe(seed.documentId)
  })

  it('delivers an event published on one instance to the meta clients of the other', async () => {
    const seed = await seedProject(pool)
    const onA = track(connectMeta(a.url, seed.projectId, tokenFor(seed.owner, seed.projectId)))
    const onB = track(connectMeta(b.url, seed.projectId, tokenFor(seed.owner, seed.projectId)))
    await Promise.all([onA.ready, onB.ready])
    const received = [onA, onB].map(statelessMessages)
    const event: ProjectEvent = {
      type: 'member.removed',
      userId: '0b9f8d3e-5a4c-4b1e-9f2a-3c4d5e6f7a8b',
      actorId: seed.owner,
    }

    const response = await internalPost(a.httpUrl, `/internal/projects/${seed.projectId}/events`, {
      event,
    })
    expect(response.status).toBe(200)
    await eventually(() => received.every((messages) => messages.length > 0))
    // Exactement une fois chacun : ni doublon par l'extension Redis, ni écho.
    await new Promise((resolve) => setTimeout(resolve, 300))
    for (const messages of received) {
      expect(messages.map((payload) => parseProjectEventMessage(payload)?.event)).toEqual([event])
    }
  })

  it('delivers a banner published on instance A to the user channels of instance B, once', async () => {
    const seed = await seedProject(pool)
    const onA = track(connectUserChannel(a.url, seed.owner, userTokenFor(seed.owner)))
    const onB = track(connectUserChannel(b.url, seed.owner, userTokenFor(seed.owner)))
    await Promise.all([onA.ready, onB.ready])
    const received = [onA, onB].map(statelessMessages)
    const event = { type: 'banner.changed' as const, banners: [] }

    const response = await internalPost(a.httpUrl, '/internal/events', { event })
    expect(response.status).toBe(200)
    await eventually(() => received.every((messages) => messages.length > 0))
    await new Promise((resolve) => setTimeout(resolve, 300))
    for (const messages of received) {
      expect(messages.map((payload) => parseProjectEventMessage(payload)?.event)).toEqual([event])
    }
  })

  it('closes the user channel of a banned user on the other instance', async () => {
    const seed = await seedProject(pool)
    const onB = track(connectUserChannel(b.url, seed.owner, userTokenFor(seed.owner)))
    await onB.ready
    const closed = closedFlag(onB)
    await pool.query('UPDATE users SET banned_at = now() WHERE id = $1', [seed.owner])
    const response = await internalPost(a.httpUrl, `/internal/users/${seed.owner}/disconnect`)
    expect(await response.json()).toEqual({ connections: 0 })
    await eventually(closed, 2_000)
  })

  it('disconnects a member removed through instance A from instance B in less than 2 seconds', async () => {
    const seed = await seedProject(pool)
    const editor = await seed.addMember('editor')
    const token = tokenFor(editor, seed.projectId, { role: 'editor' })
    const onB = track(connect(b.url, seed.projectId, seed.documentId, token))
    const metaOnB = track(connectMeta(b.url, seed.projectId, token))
    await Promise.all([onB.ready, metaOnB.ready])
    const closed = [onB, metaOnB].map(closedFlag)

    await pool.query('DELETE FROM project_members WHERE project_id = $1 AND user_id = $2', [
      seed.projectId,
      editor,
    ])
    const started = Date.now()
    // L'API appelle une seule instance (A), qui n'a aucune connexion de ce membre.
    const response = await internalPost(
      a.httpUrl,
      `/internal/projects/${seed.projectId}/members/${editor}/changed`,
    )
    expect(await response.json()).toEqual({ closed: 0, updated: 0 })
    await eventually(() => closed.every((isClosed) => isClosed()), 2_000)
    expect(Date.now() - started).toBeLessThan(2_000)
  })

  it('closes every connection of a banned user on the other instance', async () => {
    const seed = await seedProject(pool)
    const editor = await seed.addMember('editor')
    const onB = track(
      connect(
        b.url,
        seed.projectId,
        seed.documentId,
        tokenFor(editor, seed.projectId, { role: 'editor' }),
      ),
    )
    await onB.ready
    const closed = closedFlag(onB)
    await pool.query('UPDATE users SET banned_at = now() WHERE id = $1', [editor])

    const response = await internalPost(a.httpUrl, `/internal/users/${editor}/disconnect`)
    expect(await response.json()).toEqual({ connections: 0 })
    await eventually(closed, 2_000)
  })

  it('closes a deleted document on the other instance', async () => {
    const seed = await seedProject(pool)
    const onB = track(
      connect(b.url, seed.projectId, seed.documentId, tokenFor(seed.owner, seed.projectId)),
    )
    await onB.ready
    const closed = closedFlag(onB)
    const response = await internalPost(a.httpUrl, `/internal/documents/${seed.documentId}/close`)
    expect(await response.json()).toEqual({ closed: false })
    await eventually(closed, 2_000)
  })
})

/**
 * Instantané (compilation, recherche) demandé à une instance pour un document édité sur une
 * autre : enregistrement en base très différé, pour que seul le relais Redis apporte le texte.
 */
describe('project snapshot across instances', () => {
  let slowA: { server: RealtimeServer; url: string; httpUrl: string }
  let slowB: { server: RealtimeServer; url: string; httpUrl: string }

  beforeAll(async () => {
    const redis = { REDIS_URL, REDIS_PREFIX: `kaxolax-realtime-test-${randomUUID()}` }
    slowA = await startServer(store, 30_000, {}, redis)
    slowB = await startServer(store, 30_000, {}, redis)
  })

  afterAll(async () => {
    await Promise.all([slowA.server.destroy(), slowB.server.destroy()])
  })

  async function snapshotOn(httpUrl: string, projectId: string): Promise<string[]> {
    const response = await fetch(`${httpUrl}/internal/projects/${projectId}/snapshot`, {
      headers: { [INTERNAL_TOKEN_HEADER]: INTERNAL_TOKEN },
    })
    expect(response.status).toBe(200)
    return projectSnapshotSchema.parse(await response.json()).documents.map((doc) => doc.content)
  }

  it('returns on instance B the text just edited on instance A (document not open on B)', async () => {
    const seed = await seedProject(pool, 'Bonjour')
    const onA = track(
      connect(slowA.url, seed.projectId, seed.documentId, tokenFor(seed.owner, seed.projectId)),
    )
    await onA.ready
    onA.text.insert(7, ' le monde')
    onA.text.delete(0, 1)
    await eventually(() => !onA.provider.hasUnsyncedChanges)

    // La base a encore l'ancien texte : B l'obtient de A par Redis avant de répondre, sans
    // attendre le déchargement du document (environ 2 s avec l'extension Redis).
    const started = Date.now()
    expect(await snapshotOn(slowB.httpUrl, seed.projectId)).toEqual(['onjour le monde'])
    expect(Date.now() - started).toBeLessThan(1_500)
  })

  it('waits for a deletion made on A when the document is also open on B', async () => {
    const seed = await seedProject(pool, 'Bonjour le monde')
    const token = tokenFor(seed.owner, seed.projectId)
    const onA = track(connect(slowA.url, seed.projectId, seed.documentId, token))
    const onB = track(connect(slowB.url, seed.projectId, seed.documentId, token))
    await Promise.all([onA.ready, onB.ready])

    // Une suppression seule n'avance pas le vecteur d'état : l'attente porte aussi dessus.
    for (let round = 0; round < 5; round++) {
      onA.text.insert(onA.text.length, ` ${String(round)}`)
      onA.text.delete(0, 1)
      await eventually(() => !onA.provider.hasUnsyncedChanges)
      expect(await snapshotOn(slowB.httpUrl, seed.projectId)).toEqual([onA.text.toJSON()])
    }
  })
})
