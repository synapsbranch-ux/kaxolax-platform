import { type Connection, IncomingMessage } from '@hocuspocus/server'
import { type ProjectRole, storageStateMessageSchema } from '@kaxolax/contracts'
import { pino } from 'pino'
import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { type ConnectionContext, createAccessControl } from '../src/access.js'
import { createStorageGuard } from '../src/storage.js'
import type { DocumentStore } from '../src/store.js'

/**
 * Tests unitaires de la limite de stockage appliquée aux éditions (sans base) : lecture seule
 * quand le stockage du propriétaire est plein, écriture rendue quand il se libère, sans perdre
 * les éditions refusées entre-temps.
 */

const SYNC_STEP_1 = 0
const SYNC_STEP_2 = 1
const SYNC_UPDATE = 2
const logger = pino({ level: 'silent' })

function fakeStorage(initial: { used: number; limit: number } | null) {
  const state = { value: initial, reads: 0, fail: false }
  const store = {
    ownerStorage: () => {
      state.reads++
      if (state.fail) return Promise.reject(new Error('database down'))
      return Promise.resolve(
        state.value ? { ownerId: 'owner', plan: 'free', ...state.value } : null,
      )
    },
  }
  return { store, state }
}

function fakeConnection(role: ProjectRole, userId = 'user') {
  const context: ConnectionContext = {
    userId,
    projectId: 'project',
    documentId: 'document',
    role,
    issuedAt: 1,
    roleCheckedAt: Date.now(),
    rejectedUpdates: 0,
  }
  const sent: string[] = []
  /** Messages binaires envoyés (protocole Hocuspocus). */
  const binary: Uint8Array[] = []
  const state = { closed: false }
  const document = Object.assign(new Y.Doc(), { hasConnection: () => true })
  const connection = {
    context,
    readOnly: role === 'viewer' || role === 'reviewer',
    messageAddress: 'project:project:doc:document',
    sendStateless: (message: string) => sent.push(message),
    send: (message: Uint8Array) => binary.push(message),
    close: () => {
      state.closed = true
    },
    document,
  }
  return {
    connection: connection as unknown as Connection,
    raw: connection,
    context,
    sent,
    binary,
    state,
    document,
  }
}

describe('storage limit on edits', () => {
  it('makes an editor read-only while the owner storage is full, then writable again', async () => {
    let now = 0
    const { store, state } = fakeStorage({ used: 100, limit: 100 })
    const guard = createStorageGuard({ store, logger, checkMs: 1_000, now: () => now })
    const { connection, raw, context, sent } = fakeConnection('editor')

    await guard.beforeSync(connection, SYNC_UPDATE)
    expect(raw.readOnly).toBe(true)
    expect(context.storageFull).toBe(true)
    // Collaborateur : l'usage de tout le compte du propriétaire ne lui est pas envoyé.
    expect(sent.map((message) => storageStateMessageSchema.parse(JSON.parse(message)))).toEqual([
      { type: 'plan.storage', full: true, plan: 'free', max: 100 },
    ])
    const owner = fakeConnection('owner', 'owner')
    await guard.beforeSync(owner.connection, SYNC_UPDATE)
    expect(owner.sent.map((message) => JSON.parse(message) as unknown)).toEqual([
      { type: 'plan.storage', full: true, plan: 'free', max: 100, current: 100 },
    ])

    // État réutilisé pendant `checkMs` : pas de nouvelle lecture, pas de nouveau message.
    state.value = { used: 10, limit: 100 }
    await guard.beforeSync(connection, SYNC_UPDATE)
    expect(state.reads).toBe(1)
    expect(raw.readOnly).toBe(true)

    now = 1_000
    await guard.beforeSync(connection, SYNC_UPDATE)
    expect(state.reads).toBe(2)
    expect(raw.readOnly).toBe(false)
    expect(context.storageFull).toBe(false)
    expect(JSON.parse(sent.at(-1) ?? '{}')).toEqual({
      type: 'plan.storage',
      full: false,
      plan: 'free',
      max: 100,
    })
  })

  it('keeps the edits refused while full once space is freed (resync from the client)', async () => {
    let now = 0
    const { store, state } = fakeStorage({ used: 100, limit: 100 })
    const guard = createStorageGuard({ store, logger, checkMs: 1_000, now: () => now })
    const { connection, raw, binary, document: server } = fakeConnection('editor')
    const client = new Y.Doc()
    const text = client.getText('content')
    // Hocuspocus : une mise à jour n'est appliquée que si la connexion n'est pas en lecture seule.
    const receive = async (type: number, update: Uint8Array) => {
      await guard.beforeSync(connection, type)
      if (!raw.readOnly) Y.applyUpdate(server, update)
    }
    const edit = (index: number, content: string) => {
      const before = Y.encodeStateVector(client)
      text.insert(index, content)
      return Y.encodeStateAsUpdate(client, before)
    }

    // Stockage plein : la première édition est refusée et n'existe que chez le client.
    await receive(SYNC_UPDATE, edit(0, 'first '))
    expect(server.getText('content').toJSON()).toBe('')

    // Place libérée : l'édition suivante dépend de la première, jamais reçue par le serveur.
    state.value = { used: 10, limit: 100 }
    now = 1_000
    await receive(SYNC_UPDATE, edit(6, 'second'))
    expect(raw.readOnly).toBe(false)

    // Le serveur a demandé une resynchronisation (étape 1) ; le client y répond par l'étape 2.
    expect(binary).toHaveLength(1)
    const message = new IncomingMessage(binary[0])
    expect(message.readVarString()).toBe(raw.messageAddress)
    expect(message.readVarUint()).toBe(0) // MessageType.Sync
    expect(message.readVarUint()).toBe(SYNC_STEP_1)
    await receive(SYNC_STEP_2, Y.encodeStateAsUpdate(client, message.readVarUint8Array()))
    expect(server.getText('content').toJSON()).toBe('first second')
    expect(Y.encodeStateAsUpdate(server)).toEqual(Y.encodeStateAsUpdate(client))
  })

  it('reads the storage again after a document of the project is stored', async () => {
    const { store, state } = fakeStorage({ used: 10, limit: 100 })
    const guard = createStorageGuard({ store, logger, checkMs: 60_000 })
    const { connection, raw } = fakeConnection('owner')
    await guard.beforeSync(connection, SYNC_UPDATE)
    expect(raw.readOnly).toBe(false)
    state.value = { used: 150, limit: 100 }
    guard.invalidate('project')
    await guard.beforeSync(connection, SYNC_UPDATE)
    expect(raw.readOnly).toBe(true)
  })

  it('leaves readers, other messages and an unreachable database alone', async () => {
    const { store, state } = fakeStorage({ used: 100, limit: 100 })
    const guard = createStorageGuard({ store, logger, checkMs: 0 })
    const viewer = fakeConnection('viewer')
    await guard.beforeSync(viewer.connection, SYNC_UPDATE)
    expect(viewer.sent).toEqual([])
    const editor = fakeConnection('editor')
    // Étape 1 de synchronisation (aucune modification) : rien à contrôler.
    await guard.beforeSync(editor.connection, 0)
    expect(state.reads).toBe(0)
    state.fail = true
    await guard.beforeSync(editor.connection, SYNC_UPDATE)
    expect(editor.raw.readOnly).toBe(false)
  })

  it('does not close a writer refused for storage, nor give it back writing on a role read', async () => {
    const { store } = fakeStorage({ used: 100, limit: 100 })
    const guard = createStorageGuard({ store, logger, checkMs: 60_000 })
    const access = createAccessControl({
      store: { memberRole: () => Promise.resolve('editor') } as unknown as DocumentStore,
      logger,
      roleRecheckMs: 60_000,
    })
    const { connection, raw, context, state } = fakeConnection('editor')
    const document = new Y.Doc()
    for (let attempt = 0; attempt < 8; attempt++) {
      await access.beforeSync(connection, document, SYNC_UPDATE, new Uint8Array())
      await guard.beforeSync(connection, SYNC_UPDATE)
    }
    expect(raw.readOnly).toBe(true)
    expect(context.rejectedUpdates).toBe(0)
    expect(state.closed).toBe(false)

    // Relecture du rôle (inchangé) : la lecture seule due au stockage reste.
    await access.recheck(connection)
    expect(raw.readOnly).toBe(true)
  })
})
