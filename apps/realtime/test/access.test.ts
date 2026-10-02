import type { Connection, Hocuspocus } from '@hocuspocus/server'
import type { ProjectRole } from '@kaxolax/contracts'
import { pino } from 'pino'
import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { type ConnectionContext, createAccessControl } from '../src/access.js'
import type { DocumentStore } from '../src/store.js'

/**
 * Tests unitaires de l'ordre des lectures de rôle : des lectures concurrentes (mise à jour,
 * notification de l'API, balayage) peuvent revenir dans le désordre ; seule la plus récente compte.
 */

/** Lecture de rôle en attente, résolue à la main par le test. */
interface PendingRead {
  resolve: (role: ProjectRole | null) => void
}

function fakeStore() {
  const pending: PendingRead[] = []
  const store = {
    memberRole: () =>
      new Promise<ProjectRole | null>((resolve) => {
        pending.push({ resolve })
      }),
  }
  return { store: store as unknown as DocumentStore, pending }
}

function fakeConnection(role: ProjectRole) {
  const context: ConnectionContext = {
    userId: 'user',
    userName: 'User',
    avatarUrl: null,
    projectId: 'project',
    documentId: 'document',
    meta: false,
    role,
    issuedAt: 1,
    roleCheckedAt: 0,
    rejectedUpdates: 0,
  }
  const sent: string[] = []
  const state = { closed: false }
  const connection = {
    context,
    readOnly: role === 'viewer' || role === 'reviewer',
    sendStateless: (message: string) => sent.push(message),
    close: () => {
      state.closed = true
    },
    document: { hasConnection: () => true },
  }
  return { connection: connection as unknown as Connection, raw: connection, context, sent, state }
}

function fakeInstance(connections: Connection[]): Hocuspocus {
  const document = { getConnections: () => connections }
  return { documents: new Map([['doc', document]]) } as unknown as Hocuspocus
}

const flush = () => new Promise((resolve) => setImmediate(resolve))

describe('stale role reads', () => {
  it('ignores a read started before a newer change already applied', async () => {
    const { store, pending } = fakeStore()
    const access = createAccessControl({
      store,
      logger: pino({ level: 'silent' }),
      roleRecheckMs: 0,
    })
    const member = fakeConnection('editor')
    const instance = fakeInstance([member.connection])

    // Mise à jour d'un éditeur : lecture lancée avant le changement de rôle.
    const update = Y.encodeStateAsUpdate(new Y.Doc())
    const sync = access.beforeSync(member.connection, new Y.Doc(), 2, update)
    await flush()
    // Notification de l'API après validation : relue « viewer », appliquée.
    const change = access.applyMemberChange(instance, { projectId: 'project', userId: 'user' })
    await flush()
    pending[1]?.resolve('viewer')
    expect(await change).toEqual({ closed: 0, updated: 1 })
    expect(member.raw.readOnly).toBe(true)

    // La première lecture revient ensuite avec l'ancien rôle : ignorée, mise à jour rejetée.
    pending[0]?.resolve('editor')
    await sync
    expect(member.raw.readOnly).toBe(true)
    expect(member.context.role).toBe('viewer')
    expect(member.context.rejectedUpdates).toBe(1)
    expect(member.sent).toHaveLength(1)
  })

  it('does not overwrite a newer change with a value cached by the sweep', async () => {
    const { store, pending } = fakeStore()
    const access = createAccessControl({
      store,
      logger: pino({ level: 'silent' }),
      roleRecheckMs: 0,
    })
    const first = fakeConnection('editor')
    const second = fakeConnection('editor')
    const instance = fakeInstance([first.connection, second.connection])

    const sweep = access.sweep(instance)
    await flush()
    // Le balayage a lu « editor » pour la clé, puis un changement est notifié avant la 2e connexion.
    const change = access.applyMemberChange(instance, { projectId: 'project', userId: 'user' })
    await flush()
    pending[1]?.resolve('viewer')
    await change
    pending[0]?.resolve('editor')
    await sweep
    expect(first.raw.readOnly).toBe(true)
    expect(second.raw.readOnly).toBe(true)
  })

  it('does not start a sweep while the previous one is running', async () => {
    const { store, pending } = fakeStore()
    const access = createAccessControl({
      store,
      logger: pino({ level: 'silent' }),
      roleRecheckMs: 0,
    })
    const member = fakeConnection('viewer')
    const instance = fakeInstance([member.connection])

    const firstSweep = access.sweep(instance)
    const secondSweep = access.sweep(instance)
    await flush()
    expect(pending).toHaveLength(1)
    expect(await secondSweep).toEqual({ closed: 0, updated: 0 })
    pending[0]?.resolve(null)
    expect(await firstSweep).toEqual({ closed: 1, updated: 0 })
    expect(member.state.closed).toBe(true)

    // Le balayage suivant peut repartir.
    const thirdSweep = access.sweep(instance)
    await flush()
    expect(pending).toHaveLength(2)
    pending[1]?.resolve(null)
    await thirdSweep
  })
})
