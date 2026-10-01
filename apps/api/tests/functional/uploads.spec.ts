import { readDocumentText } from '@kaxolax/collab'
import { MAX_UPLOAD_BYTES } from '@kaxolax/contracts'
import testUtils from '@adonisjs/core/services/test_utils'
import { test } from '@japa/runner'
import type { ApiClient } from '@japa/api-client'
import { DateTime } from 'luxon'
import Document from '#models/document'
import File from '#models/file'
import ProjectMember from '#models/project_member'
import Upload from '#models/upload'
import type User from '#models/user'
import ObjectStorage from '#services/object_storage'
import { createUser } from '#tests/helpers'

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 1, 2, 3])
const storage = new ObjectStorage()

async function newProject(client: ApiClient, user: User): Promise<string> {
  const response = await client.post('/api/v1/projects').json({ name: 'Uploads' }).loginAs(user)
  return response.body().project.id as string
}

/** Parcours complet côté navigateur : URL présignée, PUT direct vers S3, complétion. */
async function upload(
  client: ApiClient,
  user: User,
  projectId: string,
  filename: string,
  content: Buffer,
  folderId: string | null = null,
) {
  const started = await client
    .post(`/api/v1/projects/${projectId}/uploads`)
    .json({ filename, folderId, sizeBytes: content.length })
    .loginAs(user)
  started.assertStatus(201)
  const { uploadId, url } = started.body() as { uploadId: string; url: string }
  const put = await fetch(url, { method: 'PUT', body: content })
  if (!put.ok) throw new Error(`S3 PUT failed: ${String(put.status)}`)
  return client.post(`/api/v1/projects/${projectId}/uploads/${uploadId}/complete`).loginAs(user)
}

test.group('uploads', (group) => {
  group.each.setup(() => testUtils.db().wrapInGlobalTransaction())

  test('stores an image in S3 and serves it through a presigned URL', async ({
    client,
    assert,
  }) => {
    const user = await createUser()
    const projectId = await newProject(client, user)
    const folder = await client
      .post(`/api/v1/projects/${projectId}/folders`)
      .json({ name: 'figures' })
      .loginAs(user)
    const folderId = folder.body().folder.id as string

    const completed = await upload(client, user, projectId, 'plot.png', PNG, folderId)
    completed.assertStatus(201)
    completed.assertBodyContains({
      type: 'file',
      file: { folderId, name: 'plot.png', sizeBytes: PNG.length, mimeType: 'image/png' },
    })
    const file = await File.findOrFail(completed.body().file.id)
    assert.equal(file.s3Key, `projects/${projectId}/files/${file.id}`)
    const upload_ = await Upload.query().where('projectId', projectId).firstOrFail()
    assert.equal(upload_.status, 'completed')
    assert.isNull(await storage.size(upload_.s3Key))

    const tree = await client.get(`/api/v1/projects/${projectId}/tree`).loginAs(user)
    assert.deepInclude(tree.body().files[0], { name: 'plot.png', path: 'figures/plot.png' })

    const link = await client
      .get(`/api/v1/projects/${projectId}/files/${file.id}/url`)
      .qs({ download: 'true' })
      .loginAs(user)
    link.assertStatus(200)
    const served = await fetch(link.body().url as string)
    assert.equal(served.headers.get('content-type'), 'image/png')
    assert.include(served.headers.get('content-disposition') ?? '', 'attachment')
    assert.deepEqual(Buffer.from(await served.arrayBuffer()), PNG)
  })

  test('turns an uploaded .bib file into a text document', async ({ client, assert }) => {
    const user = await createUser()
    const projectId = await newProject(client, user)
    const bib = Buffer.from('@book{knuth, title = {The \\TeX book}, year = 1984}\n')
    const completed = await upload(client, user, projectId, 'references.bib', bib)
    completed.assertStatus(201)
    completed.assertBodyContains({ type: 'document', document: { name: 'references.bib' } })
    const document = await Document.findOrFail(completed.body().document.id)
    assert.equal(
      readDocumentText(new Uint8Array(document.yjsState ?? Buffer.alloc(0))),
      bib.toString(),
    )
    assert.isNull(await File.query().where('projectId', projectId).first())
  })

  test('signs the announced size: S3 refuses a body of another size', async ({
    client,
    assert,
  }) => {
    const user = await createUser()
    const projectId = await newProject(client, user)
    const started = await client
      .post(`/api/v1/projects/${projectId}/uploads`)
      .json({ filename: 'plot.png', sizeBytes: 4 })
      .loginAs(user)
    const put = await fetch(started.body().url as string, { method: 'PUT', body: PNG })
    assert.equal(put.status, 403)
  })

  test('marks an upload as failed when the object is missing', async ({ client, assert }) => {
    const user = await createUser()
    const projectId = await newProject(client, user)
    const started = await client
      .post(`/api/v1/projects/${projectId}/uploads`)
      .json({ filename: 'never-sent.png', sizeBytes: 10 })
      .loginAs(user)
    const path = `/api/v1/projects/${projectId}/uploads/${String(started.body().uploadId)}/complete`
    const completed = await client.post(path).loginAs(user)
    completed.assertStatus(422)
    completed.assertBodyContains({ code: 'E_UPLOAD_MISSING' })
    const again = await client.post(path).loginAs(user)
    again.assertStatus(409)
    assert.equal((await Upload.findOrFail(started.body().uploadId)).status, 'failed')
  })

  test('refuses taken names, oversized files, viewers, foreign and expired uploads', async ({
    client,
  }) => {
    const user = await createUser()
    const projectId = await newProject(client, user)
    const start = (who: User, body: Record<string, unknown>) =>
      client.post(`/api/v1/projects/${projectId}/uploads`).json(body).loginAs(who)

    ;(await start(user, { filename: 'main.tex', sizeBytes: 10 })).assertStatus(409)
    ;(await start(user, { filename: 'big.bin', sizeBytes: MAX_UPLOAD_BYTES + 1 })).assertStatus(422)
    ;(await start(user, { filename: '../evil.png', sizeBytes: 10 })).assertStatus(422)

    const viewer = await createUser()
    await ProjectMember.create({ projectId, userId: viewer.id, role: 'viewer' })
    ;(await start(viewer, { filename: 'a.png', sizeBytes: 10 })).assertStatus(403)

    const started = await start(user, { filename: 'a.png', sizeBytes: 10 })
    const uploadId = started.body().uploadId as string
    const stranger = await createUser()
    const strangerProject = await newProject(client, stranger)
    const foreign = await client
      .post(`/api/v1/projects/${strangerProject}/uploads/${uploadId}/complete`)
      .loginAs(stranger)
    foreign.assertStatus(404)

    await Upload.query()
      .where('id', uploadId)
      .update({ expiresAt: DateTime.utc().minus({ minutes: 1 }).toSQL() })
    const expired = await client
      .post(`/api/v1/projects/${projectId}/uploads/${uploadId}/complete`)
      .loginAs(user)
    expired.assertStatus(410)
  })

  test('deletes the S3 object of a deleted file', async ({ client, assert }) => {
    const user = await createUser()
    const projectId = await newProject(client, user)
    const completed = await upload(client, user, projectId, 'plot.png', PNG)
    const file = await File.findOrFail(completed.body().file.id)
    assert.equal(await storage.size(file.s3Key), PNG.length)
    const deleted = await client
      .delete(`/api/v1/projects/${projectId}/entities/file/${file.id}`)
      .loginAs(user)
    deleted.assertStatus(204)
    assert.isNull(await storage.size(file.s3Key))
  })
})
