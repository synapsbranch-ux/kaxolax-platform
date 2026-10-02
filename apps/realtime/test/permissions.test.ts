import {
  memberChangedResponseSchema,
  REALTIME_FORBIDDEN_CLOSE_CODE,
  roleChangedMessageSchema,
  type RoleChangedMessage,
} from '@kaxolax/contracts'
import type pg from 'pg'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { MAX_REJECTED_UPDATES } from '../src/access.js'
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

let store: DocumentStore
let pool: pg.Pool
let running: { server: RealtimeServer; url: string; httpUrl: string }
const clients: Client[] = []

function track(client: Client): Client {
  clients.push(client)
  return client
}

/** Notification de l'API : rôle changé ou membre retiré. */
async function memberChanged(base: string, projectId: string, userId: string) {
  const response = await fetch(`${base}/internal/projects/${projectId}/members/${userId}/changed`, {
    method: 'POST',
    headers: { 'x-internal-token': INTERNAL_TOKEN },
  })
  expect(response.status).toBe(200)
  return memberChangedResponseSchema.parse(await response.json())
}

/** Messages de changement de rôle reçus par un client. */
function roleMessages(client: Client): RoleChangedMessage[] {
  const received: RoleChangedMessage[] = []
  client.provider.on('stateless', ({ payload }: { payload: string }) => {
    received.push(roleChangedMessageSchema.parse(JSON.parse(payload)))
  })
  return received
}

/** Vrai dès que le serveur a fermé la connexion du client au document. */
function closedFlag(client: Client): () => boolean {
  let closed = false
  client.provider.on('close', () => {
    closed = true
  })
  return () => closed
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 300))

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

describe('permissions on open connections', () => {
  it('rejects updates forced by a viewer and closes the connection if it insists', async () => {
    const seed = await seedProject(pool, 'texte')
    const viewer = await seed.addMember('viewer')
    const owner = track(
      connect(running.url, seed.projectId, seed.documentId, tokenFor(seed.owner, seed.projectId)),
    )
    // Jeton forgé avec le rôle editor : le rôle appliqué vient de la base.
    const reader = track(
      connect(
        running.url,
        seed.projectId,
        seed.documentId,
        tokenFor(viewer, seed.projectId, { role: 'editor' }),
      ),
    )
    await Promise.all([owner.ready, reader.ready])
    const readerClosed = closedFlag(reader)

    reader.text.insert(0, 'X')
    await settle()
    expect(owner.text.toJSON()).toBe('texte')
    expect(readerClosed()).toBe(false)

    for (let attempt = 1; attempt < MAX_REJECTED_UPDATES; attempt++) reader.text.insert(0, 'X')
    await eventually(readerClosed)
    await settle()
    expect(owner.text.toJSON()).toBe('texte')
  })

  it('disconnects a removed member from every document in less than 2 seconds', async () => {
    const seed = await seedProject(pool)
    const second = await seed.addDocument('second')
    const editor = await seed.addMember('editor')
    const token = tokenFor(editor, seed.projectId, { role: 'editor' })
    const removed = [seed.documentId, second].map((documentId) =>
      track(connect(running.url, seed.projectId, documentId, token)),
    )
    const owner = track(
      connect(running.url, seed.projectId, seed.documentId, tokenFor(seed.owner, seed.projectId)),
    )
    await Promise.all([...removed, owner].map((client) => client.ready))
    const closed = removed.map(closedFlag)
    const ownerClosed = closedFlag(owner)

    await pool.query('DELETE FROM project_members WHERE project_id = $1 AND user_id = $2', [
      seed.projectId,
      editor,
    ])
    const start = Date.now()
    expect(await memberChanged(running.httpUrl, seed.projectId, editor)).toEqual({
      closed: 2,
      updated: 0,
    })
    await eventually(() => closed.every((isClosed) => isClosed()), 2_000)
    expect(Date.now() - start).toBeLessThan(2_000)
    expect(ownerClosed()).toBe(false)

    const again = track(connect(running.url, seed.projectId, seed.documentId, token))
    await expect(again.ready).rejects.toThrow('authentication failed')
  })

  it('applies a change from editor to viewer and back without reconnecting', async () => {
    const seed = await seedProject(pool, 'abc')
    const editor = await seed.addMember('editor')
    const owner = track(
      connect(running.url, seed.projectId, seed.documentId, tokenFor(seed.owner, seed.projectId)),
    )
    const member = track(
      connect(
        running.url,
        seed.projectId,
        seed.documentId,
        tokenFor(editor, seed.projectId, { role: 'editor' }),
      ),
    )
    await Promise.all([owner.ready, member.ready])
    const messages = roleMessages(member)
    const memberClosed = closedFlag(member)

    member.text.insert(3, '1')
    await eventually(() => owner.text.toJSON() === 'abc1')

    await pool.query(
      `UPDATE project_members SET role = 'viewer' WHERE project_id = $1 AND user_id = $2`,
      [seed.projectId, editor],
    )
    expect(await memberChanged(running.httpUrl, seed.projectId, editor)).toEqual({
      closed: 0,
      updated: 1,
    })
    await eventually(() => messages.length === 1)
    expect(messages[0]).toEqual({ type: 'member.role-changed', role: 'viewer', readOnly: true })
    member.text.insert(0, 'X')
    await settle()
    expect(owner.text.toJSON()).toBe('abc1')
    expect(memberClosed()).toBe(false)

    // Notification répétée sans changement : aucun effet.
    expect(await memberChanged(running.httpUrl, seed.projectId, editor)).toEqual({
      closed: 0,
      updated: 0,
    })

    await pool.query(
      `UPDATE project_members SET role = 'editor' WHERE project_id = $1 AND user_id = $2`,
      [seed.projectId, editor],
    )
    await memberChanged(running.httpUrl, seed.projectId, editor)
    await eventually(() => messages.length === 2)
    expect(messages[1]).toEqual({ type: 'member.role-changed', role: 'editor', readOnly: false })
    // Les frappes refusées pendant la lecture seule bloquent les suivantes (horloge Yjs) : le
    // client resynchronise (l'interface rouvre le document) et tout est appliqué.
    member.text.insert(0, '>')
    member.provider.forceSync()
    await eventually(() => owner.text.toJSON() === member.text.toJSON())
    expect(owner.text.toJSON()).toBe('>Xabc1')
  })

  it('rechecks the role on the next update when a notification was lost', async () => {
    const recheck = await startServer(store, 50, { ROLE_RECHECK_MS: 0 })
    const local: Client[] = []
    try {
      const seed = await seedProject(pool, 'abc')
      const editor = await seed.addMember('editor')
      const owner = connect(
        recheck.url,
        seed.projectId,
        seed.documentId,
        tokenFor(seed.owner, seed.projectId),
      )
      const member = connect(
        recheck.url,
        seed.projectId,
        seed.documentId,
        tokenFor(editor, seed.projectId, { role: 'editor' }),
      )
      local.push(owner, member)
      await Promise.all([owner.ready, member.ready])

      await pool.query(
        `UPDATE project_members SET role = 'reviewer' WHERE project_id = $1 AND user_id = $2`,
        [seed.projectId, editor],
      )
      member.text.insert(0, 'X')
      await settle()
      expect(owner.text.toJSON()).toBe('abc')
    } finally {
      for (const client of local) client.destroy()
      await recheck.server.destroy()
    }
  })

  it('closes connections of members removed while their notification was lost (sweep)', async () => {
    const swept = await startServer(store, 50, { ROLE_SWEEP_MS: 100 })
    const local: Client[] = []
    try {
      const seed = await seedProject(pool)
      const viewer = await seed.addMember('viewer')
      const reader = connect(
        swept.url,
        seed.projectId,
        seed.documentId,
        tokenFor(viewer, seed.projectId, { role: 'viewer' }),
      )
      local.push(reader)
      await reader.ready
      const readerClosed = closedFlag(reader)
      await pool.query('DELETE FROM project_members WHERE project_id = $1 AND user_id = $2', [
        seed.projectId,
        viewer,
      ])
      await eventually(readerClosed, 2_000)
    } finally {
      for (const client of local) client.destroy()
      await swept.server.destroy()
    }
  })

  it('uses the Forbidden close code shared with the API', () => {
    expect(REALTIME_FORBIDDEN_CLOSE_CODE).toBe(4403)
  })
})
