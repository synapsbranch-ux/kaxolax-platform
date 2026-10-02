import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import {
  type BroadcastEvent,
  type ProjectEvent,
  publishProjectEventRequestSchema,
  shareLinkResponseSchema,
} from '@kaxolax/contracts'
import app from '@adonisjs/core/services/app'
import testUtils from '@adonisjs/core/services/test_utils'
import { test } from '@japa/runner'
import type { ApiClient } from '@japa/api-client'
import yazl from 'yazl'
import realtimeConfig from '#config/realtime'
import Document from '#models/document'
import ProjectMember from '#models/project_member'
import type User from '#models/user'
import RealtimeClient from '#services/realtime_client'
import { createUser } from '#tests/helpers'

/**
 * Événements du projet publiés par l'API sur le document meta (service temps réel simulé) : un
 * événement par modification de l'arborescence ou des membres, après validation, et aucun pour
 * une requête refusée.
 */
class FakeRealtimeClient extends RealtimeClient {
  readonly events: { projectId: string; event: ProjectEvent }[] = []
  readonly broadcasts: BroadcastEvent[] = []

  override publishProjectEvent(projectId: string, event: ProjectEvent): Promise<void> {
    // Même validation que la route du service temps réel.
    publishProjectEventRequestSchema.parse({ event })
    this.events.push({ projectId, event })
    return Promise.resolve()
  }

  override broadcastEvent(event: BroadcastEvent): Promise<void> {
    this.broadcasts.push(event)
    return Promise.resolve()
  }

  override closeDocuments(): Promise<void> {
    return Promise.resolve()
  }

  override membersChanged(): Promise<void> {
    return Promise.resolve()
  }

  /** Événements publiés pour un projet, dans l'ordre. */
  of(projectId: string): ProjectEvent[] {
    return this.events.filter((entry) => entry.projectId === projectId).map(({ event }) => event)
  }
}

let realtime: FakeRealtimeClient

function useFakeRealtime(group: Parameters<Parameters<typeof test.group>[1]>[0]) {
  group.each.setup(() => testUtils.db().wrapInGlobalTransaction())
  group.each.setup(() => {
    realtime = new FakeRealtimeClient()
    app.container.swap(RealtimeClient, () => realtime)
    return () => {
      app.container.restore(RealtimeClient)
    }
  })
}

async function newProject(client: ApiClient, user: User): Promise<string> {
  const response = await client.post('/api/v1/projects').json({ name: 'Événements' }).loginAs(user)
  response.assertStatus(201)
  return response.body().project.id as string
}

/** Envoi direct vers S3 par URL présignée, comme le navigateur. */
async function putObject(url: string, content: Buffer): Promise<void> {
  const put = await fetch(url, { method: 'PUT', body: content })
  if (!put.ok) throw new Error(`S3 PUT failed: ${String(put.status)}`)
}

async function zip(entries: Record<string, string>): Promise<Buffer> {
  const archive = new yazl.ZipFile()
  for (const [name, content] of Object.entries(entries))
    archive.addBuffer(Buffer.from(content), name)
  archive.end()
  const chunks: Buffer[] = []
  for await (const chunk of archive.outputStream) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks)
}

test.group('project events: tree', (group) => {
  useFakeRealtime(group)

  test('publishes what changed after each create, rename, move and delete', async ({
    client,
    assert,
  }) => {
    const user = await createUser()
    const projectId = await newProject(client, user)
    const base = `/api/v1/projects/${projectId}`

    const folder = await client.post(`${base}/folders`).json({ name: 'chapters' }).loginAs(user)
    const folderId = folder.body().folder.id as string
    const document = await client
      .post(`${base}/documents`)
      .json({ name: 'intro.tex', content: 'Intro' })
      .loginAs(user)
    const documentId = document.body().document.id as string
    ;(
      await client
        .patch(`${base}/entities/document/${documentId}`)
        .json({ name: 'introduction.tex' })
        .loginAs(user)
    ).assertStatus(200)
    ;(
      await client.patch(`${base}/entities/document/${documentId}`).json({ folderId }).loginAs(user)
    ).assertStatus(200)
    ;(await client.delete(`${base}/entities/folder/${folderId}`).loginAs(user)).assertStatus(204)

    assert.deepEqual(realtime.of(projectId), [
      {
        type: 'tree.changed',
        reason: 'create',
        actorId: user.id,
        changes: [
          { action: 'created', entity: 'folder', id: folderId, parentId: null, name: 'chapters' },
        ],
      },
      {
        type: 'tree.changed',
        reason: 'create',
        actorId: user.id,
        changes: [
          {
            action: 'created',
            entity: 'document',
            id: documentId,
            parentId: null,
            name: 'intro.tex',
          },
        ],
      },
      {
        type: 'tree.changed',
        reason: 'rename',
        actorId: user.id,
        changes: [
          {
            action: 'updated',
            entity: 'document',
            id: documentId,
            parentId: null,
            name: 'introduction.tex',
          },
        ],
      },
      {
        type: 'tree.changed',
        reason: 'move',
        actorId: user.id,
        changes: [
          {
            action: 'updated',
            entity: 'document',
            id: documentId,
            parentId: folderId,
            name: 'introduction.tex',
          },
        ],
      },
      {
        type: 'tree.changed',
        reason: 'delete',
        actorId: user.id,
        changes: [{ action: 'deleted', entity: 'folder', id: folderId }],
      },
    ])
  })

  test('publishes nothing for a refused change', async ({ client, assert }) => {
    const user = await createUser()
    const viewer = await createUser()
    const projectId = await newProject(client, user)
    await ProjectMember.create({ projectId, userId: viewer.id, role: 'viewer' })
    const base = `/api/v1/projects/${projectId}`

    // Nom déjà pris (main.tex existe), rôle insuffisant, entité inconnue.
    ;(await client.post(`${base}/documents`).json({ name: 'main.tex' }).loginAs(user)).assertStatus(
      409,
    )
    ;(await client.post(`${base}/folders`).json({ name: 'x' }).loginAs(viewer)).assertStatus(403)
    ;(
      await client
        .delete(`${base}/entities/file/00000000-0000-4000-8000-000000000001`)
        .loginAs(user)
    ).assertStatus(404)
    assert.deepEqual(realtime.of(projectId), [])
  })

  test('publishes the new main document', async ({ client, assert }) => {
    const user = await createUser()
    const projectId = await newProject(client, user)
    const other = await client
      .post(`/api/v1/projects/${projectId}/documents`)
      .json({ name: 'thesis.tex' })
      .loginAs(user)
    const otherId = other.body().document.id as string
    realtime.events.length = 0

    ;(
      await client
        .patch(`/api/v1/projects/${projectId}`)
        .json({ mainDocumentId: otherId })
        .loginAs(user)
    ).assertStatus(200)
    // Autre réglage : rien à diffuser sur l'arborescence.
    ;(
      await client
        .patch(`/api/v1/projects/${projectId}`)
        .json({ compiler: 'xelatex' })
        .loginAs(user)
    ).assertStatus(200)
    assert.deepEqual(realtime.of(projectId), [
      {
        type: 'tree.changed',
        reason: 'main-document',
        actorId: user.id,
        changes: [],
        mainDocumentId: otherId,
      },
    ])
  })

  test('publishes an uploaded file', async ({ client, assert }) => {
    const user = await createUser()
    const projectId = await newProject(client, user)
    const content = Buffer.from('@book{knuth, title={TAOCP}}\n')
    const started = await client
      .post(`/api/v1/projects/${projectId}/uploads`)
      .json({ filename: 'refs.bib', folderId: null, sizeBytes: content.length })
      .loginAs(user)
    const { uploadId, url } = started.body() as { uploadId: string; url: string }
    await putObject(url, content)
    const completed = await client
      .post(`/api/v1/projects/${projectId}/uploads/${uploadId}/complete`)
      .loginAs(user)
    completed.assertStatus(201)

    assert.deepEqual(realtime.of(projectId), [
      {
        type: 'tree.changed',
        reason: 'upload',
        actorId: user.id,
        changes: [
          {
            action: 'created',
            entity: 'document',
            id: completed.body().document.id as string,
            parentId: null,
            name: 'refs.bib',
          },
        ],
      },
    ])
  })

  test('publishes an imported project with its main document', async ({ client, assert }) => {
    const user = await createUser()
    const content = await zip({ 'main.tex': '\\documentclass{article}\n' })
    const started = await client
      .post('/api/v1/imports')
      .json({ filename: 'import.zip', sizeBytes: content.length })
      .loginAs(user)
    const { uploadId, url } = started.body() as { uploadId: string; url: string }
    await putObject(url, content)
    const completed = await client.post(`/api/v1/imports/${uploadId}/complete`).loginAs(user)
    completed.assertStatus(201)
    const projectId = completed.body().project.id as string
    const main = await Document.query().where({ projectId, name: 'main.tex' }).firstOrFail()

    assert.deepEqual(realtime.of(projectId), [
      {
        type: 'tree.changed',
        reason: 'import',
        actorId: user.id,
        changes: [],
        mainDocumentId: main.id,
      },
    ])
  })
})

test.group('project events: members', (group) => {
  useFakeRealtime(group)

  test('publishes role changes, removals and ownership transfers', async ({ client, assert }) => {
    const owner = await createUser()
    const editor = await createUser()
    const viewer = await createUser()
    const projectId = await newProject(client, owner)
    await ProjectMember.createMany([
      { projectId, userId: editor.id, role: 'editor' },
      { projectId, userId: viewer.id, role: 'viewer' },
    ])
    const base = `/api/v1/projects/${projectId}`

    ;(
      await client.patch(`${base}/members/${viewer.id}`).json({ role: 'reviewer' }).loginAs(owner)
    ).assertStatus(200)
    // Même rôle : aucun changement, aucun événement.
    ;(
      await client.patch(`${base}/members/${viewer.id}`).json({ role: 'reviewer' }).loginAs(owner)
    ).assertStatus(200)
    ;(await client.delete(`${base}/members/${viewer.id}`).loginAs(owner)).assertStatus(204)
    ;(
      await client.post(`${base}/transfer`).json({ userId: editor.id }).loginAs(owner)
    ).assertStatus(200)

    assert.deepEqual(realtime.of(projectId), [
      { type: 'member.role-updated', userId: viewer.id, role: 'reviewer', actorId: owner.id },
      { type: 'member.removed', userId: viewer.id, actorId: owner.id },
      { type: 'member.role-updated', userId: editor.id, role: 'owner', actorId: owner.id },
      { type: 'member.role-updated', userId: owner.id, role: 'editor', actorId: owner.id },
    ])
  })

  test('publishes a member who joins with a share link, once', async ({ client, assert }) => {
    const owner = await createUser()
    const guest = await createUser()
    const projectId = await newProject(client, owner)
    const link = shareLinkResponseSchema.parse(
      (
        await client
          .put(`/api/v1/projects/${projectId}/share-links/view`)
          .json({ enabled: true })
          .loginAs(owner)
      ).body(),
    ).link
    const token = link.url?.split('/share/')[1] ?? ''

    ;(await client.post(`/api/v1/share/${token}/join`).loginAs(guest)).assertStatus(200)
    // Déjà membre avec ce rôle : rien de nouveau.
    ;(await client.post(`/api/v1/share/${token}/join`).loginAs(guest)).assertStatus(200)
    assert.deepEqual(realtime.of(projectId), [
      { type: 'member.added', userId: guest.id, role: 'viewer', actorId: guest.id },
    ])
  })
})

test.group('project events: realtime client', () => {
  test('posts project events and banner broadcasts to the realtime service', async ({
    assert,
    cleanup,
  }) => {
    const calls: { url?: string; token?: string; body: unknown }[] = []
    const server = createServer((request, response) => {
      const chunks: Buffer[] = []
      request.on('data', (chunk: Buffer) => chunks.push(chunk))
      request.on('end', () => {
        calls.push({
          url: request.url,
          token: request.headers['x-internal-token'] as string | undefined,
          body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown,
        })
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ delivered: 1 }))
      })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const previousUrl = realtimeConfig.internalUrl
    realtimeConfig.internalUrl = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`
    cleanup(() => {
      realtimeConfig.internalUrl = previousUrl
      server.close()
    })

    const projectId = '00000000-0000-4000-8000-000000000001'
    const event: ProjectEvent = {
      type: 'member.removed',
      userId: '00000000-0000-4000-8000-000000000002',
      actorId: null,
    }
    await new RealtimeClient().publishProjectEvent(projectId, event)
    await new RealtimeClient().notifyBannerChanged([])
    assert.deepEqual(calls, [
      {
        url: `/internal/projects/${projectId}/events`,
        token: realtimeConfig.internalToken.release(),
        body: { event },
      },
      {
        url: '/internal/events',
        token: realtimeConfig.internalToken.release(),
        body: { event: { type: 'banner.changed', banners: [] } },
      },
    ])
  })

  test('never fails when the realtime service is unreachable', async ({ cleanup }) => {
    const previousUrl = realtimeConfig.internalUrl
    // Port 9 (discard) : connexion refusée immédiatement.
    realtimeConfig.internalUrl = 'http://127.0.0.1:9'
    cleanup(() => {
      realtimeConfig.internalUrl = previousUrl
    })
    await new RealtimeClient().publishProjectEvent('00000000-0000-4000-8000-000000000001', {
      type: 'member.removed',
      userId: '00000000-0000-4000-8000-000000000002',
      actorId: null,
    })
    await new RealtimeClient().broadcastEvent({ type: 'banner.changed', banners: [] })
  })
})
