import { INTERNAL_TOKEN_HEADER, projectSnapshotSchema } from '@kaxolax/contracts'
import type pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { ClusterBus } from '../src/cluster.js'
import type { DocumentStore } from '../src/store.js'
import {
  INTERNAL_TOKEN,
  openPool,
  openStore,
  type RealtimeServer,
  seedProject,
  startServer,
} from './helpers.js'

/**
 * Instantané quand le bus Redis ne répond pas (Redis indisponible : commande en file d'attente
 * hors ligne, puis rejetée) : l'attente est bornée, envoi compris, puis le texte connu ici fait foi.
 */

/** Bus dont l'envoi ne se termine jamais, ou échoue. */
function brokenBus(publishCounted: () => Promise<number>): ClusterBus {
  return {
    publish: () => publishCounted().then(() => undefined),
    publishCounted,
    subscribe: () => undefined,
    ready: () => Promise.resolve(),
    close: () => Promise.resolve(),
  }
}

let store: DocumentStore
let pool: pg.Pool
let hanging: { server: RealtimeServer; httpUrl: string }
let failing: { server: RealtimeServer; httpUrl: string }

beforeAll(async () => {
  store = openStore()
  pool = openPool()
  hanging = await startServer(
    store,
    50,
    {},
    {},
    {},
    {
      bus: brokenBus(() => new Promise<number>(() => undefined)),
    },
  )
  failing = await startServer(
    store,
    50,
    {},
    {},
    {},
    {
      bus: brokenBus(() => Promise.reject(new Error('Connection is closed.'))),
    },
  )
})

afterAll(async () => {
  await Promise.all([hanging.server.destroy(), failing.server.destroy()])
  await store.close()
  await pool.end()
})

async function snapshotOn(httpUrl: string, projectId: string): Promise<string[]> {
  const response = await fetch(`${httpUrl}/internal/projects/${projectId}/snapshot`, {
    headers: { [INTERNAL_TOKEN_HEADER]: INTERNAL_TOKEN },
  })
  expect(response.status).toBe(200)
  return projectSnapshotSchema.parse(await response.json()).documents.map((doc) => doc.content)
}

describe('project snapshot without a working cluster bus', () => {
  it('answers with the local text when publishing never completes', async () => {
    const seed = await seedProject(pool, 'Bonjour')
    const started = Date.now()
    expect(await snapshotOn(hanging.httpUrl, seed.projectId)).toEqual(['Bonjour'])
    // Délai des autres instances (1 s), jamais celui de l'API (15 s).
    expect(Date.now() - started).toBeLessThan(3_000)
  })

  it('answers with the local text at once when publishing fails', async () => {
    const seed = await seedProject(pool, 'Bonjour')
    const started = Date.now()
    expect(await snapshotOn(failing.httpUrl, seed.projectId)).toEqual(['Bonjour'])
    expect(Date.now() - started).toBeLessThan(1_000)
  })
})
