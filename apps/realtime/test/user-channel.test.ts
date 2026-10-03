import {
  type ActiveBanner,
  disconnectUserResponseSchema,
  parseProjectEventMessage,
  type ProjectEvent,
  publishEventResponseSchema,
} from '@kaxolax/contracts'
import type pg from 'pg'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { MAX_REJECTED_UPDATES } from '../src/access.js'
import type { DocumentStore } from '../src/store.js'
import {
  type Client,
  closedFlag,
  connectMeta,
  connectTo,
  connectUserChannel,
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
  userTokenFor,
} from './helpers.js'

/**
 * Canal temps réel d'un utilisateur (`user:{id}`) : ouvert par toutes les pages connectées, il
 * reçoit la bannière système en direct, sans contenu ni présence.
 */

let store: DocumentStore
let pool: pg.Pool
let running: { server: RealtimeServer; url: string; httpUrl: string }
const clients: Client[] = []

function track(client: Client): Client {
  clients.push(client)
  return client
}

function eventsOf(client: Client): () => ProjectEvent[] {
  const raw = statelessMessages(client)
  return () =>
    raw.flatMap((payload) => {
      const message = parseProjectEventMessage(payload)
      return message ? [message.event] : []
    })
}

const banners: ActiveBanner[] = [
  {
    id: '0b9f8d3e-5a4c-4b1e-9f2a-3c4d5e6f7a8b',
    message: 'Maintenance à 22 h',
    level: 'maintenance',
    startsAt: '2026-10-02T20:00:00.000Z',
    endsAt: null,
  },
]

beforeAll(async () => {
  store = openStore()
  pool = openPool()
  // Balayage rapide : un compte banni sans notification de l'API perd son canal.
  running = await startServer(store, 50, { ROLE_SWEEP_MS: 200 })
})

afterEach(() => {
  for (const client of clients.splice(0)) client.destroy()
})

afterAll(async () => {
  await running.server.destroy()
  await store.close()
  await pool.end()
})

describe('user channel', () => {
  it('opens only with a user token of its own holder', async () => {
    const seed = await seedProject(pool)
    const other = await seed.addUser()
    const own = track(connectUserChannel(running.url, seed.owner, userTokenFor(seed.owner)))
    await own.ready

    const refused = [
      // Jeton d'un autre compte.
      connectUserChannel(running.url, seed.owner, userTokenFor(other)),
      // Jeton de projet : n'ouvre jamais un canal.
      connectUserChannel(running.url, seed.owner, tokenFor(seed.owner, seed.projectId)),
      // Jeton expiré, ou signé avec un autre secret.
      connectUserChannel(running.url, seed.owner, userTokenFor(seed.owner, { expiresIn: -1 })),
      connectUserChannel(
        running.url,
        seed.owner,
        userTokenFor(seed.owner, { secret: 'another-secret-another-secret-another-0' }),
      ),
      // Un jeton de canal n'ouvre aucun document de projet.
      connectMeta(running.url, seed.projectId, userTokenFor(seed.owner)),
      connectTo(running.url, `user:${seed.owner}:extra`, userTokenFor(seed.owner)),
    ].map(track)
    for (const client of refused) await expect(client.ready).rejects.toThrow(/authentication/)
  })

  it('refuses a banned account and one whose sessions were revoked after the token', async () => {
    const seed = await seedProject(pool)
    const banned = await seed.addUser()
    const revoked = await seed.addUser()
    await pool.query('UPDATE users SET banned_at = now() WHERE id = $1', [banned])
    await pool.query(
      `UPDATE users SET sessions_revoked_at = now() + interval '1 hour' WHERE id = $1`,
      [revoked],
    )
    const refused = [
      connectUserChannel(running.url, banned, userTokenFor(banned)),
      connectUserChannel(running.url, revoked, userTokenFor(revoked)),
    ].map(track)
    for (const client of refused) await expect(client.ready).rejects.toThrow(/authentication/)
  })

  it('receives the banner broadcast once, like the meta documents', async () => {
    const seed = await seedProject(pool)
    const tab = track(connectUserChannel(running.url, seed.owner, userTokenFor(seed.owner)))
    const otherTab = track(connectUserChannel(running.url, seed.owner, userTokenFor(seed.owner)))
    const meta = track(
      connectMeta(running.url, seed.projectId, tokenFor(seed.owner, seed.projectId)),
    )
    await Promise.all([tab.ready, otherTab.ready, meta.ready])
    const received = [tab, otherTab, meta].map(eventsOf)

    const response = await internalPost(running.httpUrl, '/internal/events', {
      event: { type: 'banner.changed', banners },
    })
    expect(response.status).toBe(200)
    // Connexions de cette instance (celles d'autres tests en cours de fermeture comprises).
    expect(
      publishEventResponseSchema.parse(await response.json()).delivered,
    ).toBeGreaterThanOrEqual(3)
    await eventually(() => received.every((events) => events().length === 1))
    await settle(200)
    for (const events of received) expect(events()).toEqual([{ type: 'banner.changed', banners }])

    // Un événement d'un projet ne va pas sur le canal.
    await internalPost(running.httpUrl, `/internal/projects/${seed.projectId}/events`, {
      event: { type: 'member.removed', userId: seed.owner, actorId: null },
    })
    await eventually(() => (received[2]?.().length ?? 0) === 2)
    expect(received[0]?.()).toHaveLength(1)
  })

  it('has no content and no presence, and closes a client that keeps writing', async () => {
    const seed = await seedProject(pool)
    const writer = track(connectUserChannel(running.url, seed.owner, userTokenFor(seed.owner)))
    const watcher = track(connectUserChannel(running.url, seed.owner, userTokenFor(seed.owner)))
    await Promise.all([writer.ready, watcher.ready])
    const writerClosed = closedFlag(writer)

    writer.provider.setAwarenessField('documentId', 'x')
    writer.doc.getMap('forged').set('key', 'value')
    await settle()
    expect(watcher.doc.getMap('forged').size).toBe(0)
    expect(watcher.provider.awareness?.getStates().has(writer.doc.clientID)).toBe(false)
    for (let attempt = 1; attempt < MAX_REJECTED_UPDATES; attempt++) {
      writer.doc.getMap('forged').set(`key${String(attempt)}`, attempt)
    }
    await eventually(writerClosed)
    expect(watcher.doc.getMap('forged').size).toBe(0)
  })

  it('is closed with the other connections of a banned user, and by the sweep', async () => {
    const seed = await seedProject(pool)
    const editor = await seed.addMember('editor')
    const channel = track(connectUserChannel(running.url, editor, userTokenFor(editor)))
    const meta = track(
      connectMeta(
        running.url,
        seed.projectId,
        tokenFor(editor, seed.projectId, { role: 'editor' }),
      ),
    )
    await Promise.all([channel.ready, meta.ready])
    const closed = [channel, meta].map(closedFlag)
    await pool.query('UPDATE users SET banned_at = now() WHERE id = $1', [editor])
    const response = await internalPost(running.httpUrl, `/internal/users/${editor}/disconnect`)
    expect(disconnectUserResponseSchema.parse(await response.json()).connections).toBe(2)
    await eventually(() => closed.every((isClosed) => isClosed()))

    // Sans notification de l'API : le balayage périodique ferme le canal.
    const other = await seed.addUser()
    const swept = track(connectUserChannel(running.url, other, userTokenFor(other)))
    await swept.ready
    const sweptClosed = closedFlag(swept)
    await pool.query('UPDATE users SET deleted_at = now() WHERE id = $1', [other])
    await eventually(sweptClosed, 3_000)
  })
})
