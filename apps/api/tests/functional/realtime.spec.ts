import { createServer, type IncomingHttpHeaders } from 'node:http'
import type { AddressInfo } from 'node:net'
import { verifyRealtimeToken } from '@kaxolax/collab/token'
import { realtimeTokenResponseSchema } from '@kaxolax/contracts'
import app from '@adonisjs/core/services/app'
import testUtils from '@adonisjs/core/services/test_utils'
import { test } from '@japa/runner'
import type { ApiClient } from '@japa/api-client'
import realtimeConfig from '#config/realtime'
import ProjectMember from '#models/project_member'
import type User from '#models/user'
import RealtimeClient from '#services/realtime_client'
import { createUser } from '#tests/helpers'

/** Enregistre les fermetures demandées au lieu d'appeler le service temps réel. */
class FakeRealtimeClient extends RealtimeClient {
  closed: string[] = []

  override async closeDocuments(documentIds: readonly string[]) {
    this.closed.push(...documentIds)
    return Promise.resolve()
  }
}

async function newProject(client: ApiClient, user: User): Promise<string> {
  const response = await client
    .post('/api/v1/projects')
    .json({ name: 'Temps réel' })
    .loginAs(user)
    .withCsrfToken()
  return response.body().project.id as string
}

test.group('realtime: connection tokens', (group) => {
  group.each.setup(() => testUtils.db().wrapInGlobalTransaction())

  test('issues a short-lived token carrying the member role', async ({ client, assert }) => {
    const user = await createUser()
    const projectId = await newProject(client, user)
    const response = await client
      .post(`/api/v1/projects/${projectId}/realtime-token`)
      .loginAs(user)
      .withCsrfToken()
    response.assertStatus(200)
    const body = realtimeTokenResponseSchema.parse(response.body())
    assert.equal(body.url, realtimeConfig.publicUrl)
    const claims = verifyRealtimeToken(body.token, realtimeConfig.tokenSecret.release())
    assert.deepInclude(claims, { sub: user.id, projectId, role: 'owner' })
    const lifetime = new Date(body.expiresAt).getTime() - Date.now()
    assert.isAbove(lifetime, 290_000)
    assert.isAtMost(lifetime, 300_000)
    // Signé avec un autre secret, le jeton est refusé.
    assert.isNull(verifyRealtimeToken(body.token, 'another-secret-another-secret-another'))
  })

  test('gives viewers a token with their own role', async ({ client, assert }) => {
    const owner = await createUser()
    const viewer = await createUser()
    const projectId = await newProject(client, owner)
    await ProjectMember.create({ projectId, userId: viewer.id, role: 'viewer' })
    const response = await client
      .post(`/api/v1/projects/${projectId}/realtime-token`)
      .loginAs(viewer)
      .withCsrfToken()
    response.assertStatus(200)
    const { token } = realtimeTokenResponseSchema.parse(response.body())
    assert.equal(verifyRealtimeToken(token, realtimeConfig.tokenSecret.release())?.role, 'viewer')
  })

  test('refuses anonymous users, missing CSRF tokens and non-members', async ({ client }) => {
    const owner = await createUser()
    const stranger = await createUser()
    const projectId = await newProject(client, owner)
    const path = `/api/v1/projects/${projectId}/realtime-token`
    ;(await client.post(path).withCsrfToken()).assertStatus(401)
    ;(await client.post(path).loginAs(owner)).assertStatus(403)
    ;(await client.post(path).loginAs(stranger).withCsrfToken()).assertStatus(404)
  })
})

test.group('realtime: closing deleted documents', (group) => {
  group.each.setup(() => testUtils.db().wrapInGlobalTransaction())
  let fake: FakeRealtimeClient
  group.each.setup(() => {
    fake = new FakeRealtimeClient()
    app.container.swap(RealtimeClient, () => fake)
    return () => {
      app.container.restore(RealtimeClient)
    }
  })

  test('closes every document of a deleted folder', async ({ client, assert }) => {
    const user = await createUser()
    const projectId = await newProject(client, user)
    const folder = await client
      .post(`/api/v1/projects/${projectId}/folders`)
      .json({ name: 'chapitres' })
      .loginAs(user)
      .withCsrfToken()
    const folderId = folder.body().folder.id as string
    const ids: string[] = []
    for (const name of ['a.tex', 'b.tex']) {
      const created = await client
        .post(`/api/v1/projects/${projectId}/documents`)
        .json({ name, folderId })
        .loginAs(user)
        .withCsrfToken()
      ids.push(created.body().document.id as string)
    }
    const deleted = await client
      .delete(`/api/v1/projects/${projectId}/entities/folder/${folderId}`)
      .loginAs(user)
      .withCsrfToken()
    deleted.assertStatus(204)
    assert.sameMembers(fake.closed, ids)
  })

  test('closes the documents of a project deleted from the trash', async ({ client, assert }) => {
    const user = await createUser()
    const projectId = await newProject(client, user)
    const tree = await client.get(`/api/v1/projects/${projectId}/tree`).loginAs(user)
    const mainDocumentId = tree.body().mainDocumentId as string
    await client.post(`/api/v1/projects/${projectId}/trash`).loginAs(user).withCsrfToken()
    const deleted = await client
      .delete(`/api/v1/projects/${projectId}`)
      .loginAs(user)
      .withCsrfToken()
    deleted.assertStatus(204)
    assert.deepEqual(fake.closed, [mainDocumentId])
  })
})

test.group('realtime: internal client', () => {
  test('calls the close route with the internal token', async ({ assert, cleanup }) => {
    const calls: { method?: string; url?: string; headers: IncomingHttpHeaders }[] = []
    const server = createServer((request, response) => {
      calls.push({ method: request.method, url: request.url, headers: request.headers })
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ closed: true }))
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const previousUrl = realtimeConfig.internalUrl
    realtimeConfig.internalUrl = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`
    cleanup(() => {
      realtimeConfig.internalUrl = previousUrl
      server.close()
    })

    const id = '00000000-0000-4000-8000-000000000001'
    await new RealtimeClient().closeDocuments([id])
    assert.lengthOf(calls, 1)
    assert.equal(calls[0]?.method, 'POST')
    assert.equal(calls[0]?.url, `/internal/documents/${id}/close`)
    assert.equal(calls[0]?.headers['x-internal-token'], realtimeConfig.internalToken.release())
  })

  test('never fails when the realtime service is unreachable', async ({ cleanup }) => {
    const previousUrl = realtimeConfig.internalUrl
    // Port 9 (discard) : connexion refusée immédiatement.
    realtimeConfig.internalUrl = 'http://127.0.0.1:9'
    cleanup(() => {
      realtimeConfig.internalUrl = previousUrl
    })
    await new RealtimeClient().closeDocuments(['00000000-0000-4000-8000-000000000002'])
  })
})
