import {
  type ActiveBanner,
  memberChangedResponseSchema,
  parsePresenceState,
  parseProjectEventMessage,
  PRESENCE_FALLBACK_NAME,
  presenceUserFor,
  type ProjectEvent,
  publishEventResponseSchema,
  roleChangedMessageSchema,
} from '@kaxolax/contracts'
import type pg from 'pg'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { MAX_REJECTED_UPDATES } from '../src/access.js'
import type { DocumentStore } from '../src/store.js'
import {
  type Client,
  closedFlag,
  connect,
  connectMeta,
  eventually,
  internalPost,
  openPool,
  openStore,
  type RealtimeServer,
  seedProject,
  settle,
  startServer,
  statelessMessages,
  tokenFor,
} from './helpers.js'

/**
 * Document meta du projet : autorisation, rejet de toute écriture de contenu, événements publiés
 * par l'API et identité imposée dans l'awareness.
 */

let store: DocumentStore
let pool: pg.Pool
let running: { server: RealtimeServer; url: string; httpUrl: string }
const clients: Client[] = []

function track(client: Client): Client {
  clients.push(client)
  return client
}

/** Événements valides reçus par un client (les autres messages sans état sont ignorés). */
function eventsOf(client: Client): () => ProjectEvent[] {
  const raw = statelessMessages(client)
  return () =>
    raw.flatMap((payload) => {
      const message = parseProjectEventMessage(payload)
      return message ? [message.event] : []
    })
}

const treeEvent = (actorId: string): ProjectEvent => ({
  type: 'tree.changed',
  reason: 'create',
  actorId,
  changes: [
    {
      action: 'created',
      entity: 'folder',
      id: '6f1c2d3e-4b5a-4c7d-8e9f-0a1b2c3d4e5f',
      parentId: null,
      name: 'figures',
    },
  ],
})

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

describe('meta document', () => {
  it('lets every member connect, and nobody else', async () => {
    const seed = await seedProject(pool)
    const viewer = await seed.addMember('viewer')
    const outsider = await seed.addUser()
    const other = await seedProject(pool)
    const owner = track(
      connectMeta(running.url, seed.projectId, tokenFor(seed.owner, seed.projectId)),
    )
    const reader = track(
      connectMeta(
        running.url,
        seed.projectId,
        tokenFor(viewer, seed.projectId, { role: 'viewer' }),
      ),
    )
    await Promise.all([owner.ready, reader.ready])

    const refused = [
      // Non-membre, même avec un jeton signé pour ce projet.
      connectMeta(running.url, seed.projectId, tokenFor(outsider, seed.projectId)),
      // Jeton d'un autre projet.
      connectMeta(running.url, seed.projectId, tokenFor(other.owner, other.projectId)),
    ].map(track)
    for (const client of refused) await expect(client.ready).rejects.toThrow(/authentication/)
  })

  it('rejects content updates from every role, the owner included', async () => {
    const seed = await seedProject(pool)
    const writer = track(
      connectMeta(running.url, seed.projectId, tokenFor(seed.owner, seed.projectId)),
    )
    const watcher = track(
      connectMeta(running.url, seed.projectId, tokenFor(seed.owner, seed.projectId)),
    )
    await Promise.all([writer.ready, watcher.ready])
    const writerClosed = closedFlag(writer)

    writer.doc.getMap('forged').set('key', 'value')
    await settle()
    expect(watcher.doc.getMap('forged').size).toBe(0)

    for (let attempt = 1; attempt < MAX_REJECTED_UPDATES; attempt++) {
      writer.doc.getMap('forged').set(`key${String(attempt)}`, attempt)
    }
    await eventually(writerClosed)
    expect(watcher.doc.getMap('forged').size).toBe(0)
  })

  it('stays read-only when the role of an editor is reapplied', async () => {
    const seed = await seedProject(pool)
    const editor = await seed.addMember('editor')
    const client = track(
      connectMeta(
        running.url,
        seed.projectId,
        tokenFor(editor, seed.projectId, { role: 'editor' }),
      ),
    )
    const watcher = track(
      connectMeta(running.url, seed.projectId, tokenFor(seed.owner, seed.projectId)),
    )
    await Promise.all([client.ready, watcher.ready])
    const roles = statelessMessages(client)

    await pool.query(
      `UPDATE project_members SET role = 'viewer' WHERE project_id = $1 AND user_id = $2`,
      [seed.projectId, editor],
    )
    let response = await internalPost(
      running.httpUrl,
      `/internal/projects/${seed.projectId}/members/${editor}/changed`,
    )
    expect(memberChangedResponseSchema.parse(await response.json()).updated).toBe(1)
    await pool.query(
      `UPDATE project_members SET role = 'editor' WHERE project_id = $1 AND user_id = $2`,
      [seed.projectId, editor],
    )
    response = await internalPost(
      running.httpUrl,
      `/internal/projects/${seed.projectId}/members/${editor}/changed`,
    )
    expect(response.status).toBe(200)
    await eventually(() => roles.length === 2)
    // Le message décrit les documents du projet : de nouveau en écriture.
    expect(roleChangedMessageSchema.parse(JSON.parse(roles[1] ?? ''))).toEqual({
      type: 'member.role-changed',
      role: 'editor',
      readOnly: false,
    })

    client.doc.getMap('forged').set('key', 'value')
    await settle()
    expect(watcher.doc.getMap('forged').size).toBe(0)
  })

  it('never stores anything for the meta document', async () => {
    const seed = await seedProject(pool)
    const client = track(
      connectMeta(running.url, seed.projectId, tokenFor(seed.owner, seed.projectId)),
    )
    await client.ready
    const { rows } = await pool.query<{ count: string }>(
      'SELECT count(*) FROM documents WHERE project_id = $1',
      [seed.projectId],
    )
    expect(rows[0]?.count).toBe('1')
  })
})

describe('project events', () => {
  it('delivers an event published by the API to the meta clients of the project only', async () => {
    const seed = await seedProject(pool)
    const viewer = await seed.addMember('viewer')
    const other = await seedProject(pool)
    const owner = track(
      connectMeta(running.url, seed.projectId, tokenFor(seed.owner, seed.projectId)),
    )
    const reader = track(
      connectMeta(
        running.url,
        seed.projectId,
        tokenFor(viewer, seed.projectId, { role: 'viewer' }),
      ),
    )
    // Un client du document texte ne reçoit pas les événements, ni un autre projet.
    const editorTab = track(
      connect(running.url, seed.projectId, seed.documentId, tokenFor(seed.owner, seed.projectId)),
    )
    const stranger = track(
      connectMeta(running.url, other.projectId, tokenFor(other.owner, other.projectId)),
    )
    await Promise.all([owner.ready, reader.ready, editorTab.ready, stranger.ready])
    const received = [owner, reader, editorTab, stranger].map(eventsOf)

    const event = treeEvent(seed.owner)
    const response = await internalPost(
      running.httpUrl,
      `/internal/projects/${seed.projectId}/events`,
      { event },
    )
    expect(response.status).toBe(200)
    expect(publishEventResponseSchema.parse(await response.json())).toEqual({ delivered: 2 })
    await eventually(() => received.slice(0, 2).every((events) => events().length === 1))
    expect(received[0]?.()).toEqual([event])
    expect(received[1]?.()).toEqual([event])
    await settle()
    expect(received[2]?.()).toEqual([])
    expect(received[3]?.()).toEqual([])
  })

  it('broadcasts banner changes to every project', async () => {
    const first = await seedProject(pool)
    const second = await seedProject(pool)
    const clientsOf = [first, second].map((seed) =>
      track(connectMeta(running.url, seed.projectId, tokenFor(seed.owner, seed.projectId))),
    )
    await Promise.all(clientsOf.map((client) => client.ready))
    const received = clientsOf.map(eventsOf)
    const banners: ActiveBanner[] = [
      {
        id: '0b9f8d3e-5a4c-4b1e-9f2a-3c4d5e6f7a8b',
        message: 'Maintenance à 22 h',
        level: 'maintenance',
        startsAt: '2026-10-02T20:00:00.000Z',
        endsAt: null,
      },
    ]
    const response = await internalPost(running.httpUrl, '/internal/events', {
      event: { type: 'banner.changed', banners },
    })
    expect(response.status).toBe(200)
    await eventually(() => received.every((events) => events().length === 1))
    expect(received[0]?.()).toEqual([{ type: 'banner.changed', banners }])
  })

  it('refuses invalid events, project events sent to everyone and calls without the token', async () => {
    const seed = await seedProject(pool)
    const path = `/internal/projects/${seed.projectId}/events`
    const invalid = await internalPost(running.httpUrl, path, { event: { type: 'tree.changed' } })
    expect(invalid.status).toBe(400)
    const notJson = await fetch(`${running.httpUrl}${path}`, {
      method: 'POST',
      headers: { 'x-internal-token': 'test-internal-token-0123456789abcdefghij' },
      body: '{',
    })
    expect(notJson.status).toBe(400)
    const broadcastTree = await internalPost(running.httpUrl, '/internal/events', {
      event: treeEvent(seed.owner),
    })
    expect(broadcastTree.status).toBe(400)
    const anonymous = await fetch(`${running.httpUrl}${path}`, {
      method: 'POST',
      body: JSON.stringify({ event: treeEvent(seed.owner) }),
    })
    expect(anonymous.status).toBe(401)
  })
})

describe('presence', () => {
  it('replaces a forged identity with the one of the connection', async () => {
    const seed = await seedProject(pool)
    const editor = await seed.addMember('editor')
    await pool.query(
      `UPDATE users SET full_name = 'Ada Lovelace', avatar_url = 'https://img.clerk.com/ada.png'
       WHERE id = $1`,
      [editor],
    )
    const forger = track(
      connectMeta(
        running.url,
        seed.projectId,
        tokenFor(editor, seed.projectId, { role: 'editor' }),
      ),
    )
    const watcher = track(
      connectMeta(running.url, seed.projectId, tokenFor(seed.owner, seed.projectId)),
    )
    await Promise.all([forger.ready, watcher.ready])

    // Se fait passer pour le propriétaire, avec une couleur injectée.
    forger.provider.setAwarenessField('user', {
      id: seed.owner,
      name: 'Propriétaire',
      colorIndex: 0,
      color: 'red',
      colorLight: 'red',
    })
    forger.provider.setAwarenessField('documentId', seed.documentId)

    const stateOfForger = () =>
      watcher.provider.awareness?.getStates().get(forger.doc.clientID) as unknown
    await eventually(() => parsePresenceState(stateOfForger()) !== null)
    expect(parsePresenceState(stateOfForger())).toEqual({
      user: presenceUserFor(editor, 'Ada Lovelace', 'https://img.clerk.com/ada.png'),
      documentId: seed.documentId,
    })
  })

  it('never shows the email of a user without a full name', async () => {
    const seed = await seedProject(pool)
    const client = track(
      connectMeta(running.url, seed.projectId, tokenFor(seed.owner, seed.projectId)),
    )
    const watcher = track(
      connectMeta(running.url, seed.projectId, tokenFor(seed.owner, seed.projectId)),
    )
    await Promise.all([client.ready, watcher.ready])
    client.provider.setAwarenessField('documentId', null)
    const state = () => watcher.provider.awareness?.getStates().get(client.doc.clientID) as unknown
    await eventually(() => parsePresenceState(state()) !== null)
    expect(parsePresenceState(state())?.user.name).toBe(PRESENCE_FALLBACK_NAME)
    expect(JSON.stringify(state())).not.toContain('@example.test')
  })
})
