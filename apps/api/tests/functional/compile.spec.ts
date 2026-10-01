import { createHash, randomUUID } from 'node:crypto'
import { rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  type CompileRequest,
  compileResultSchema,
  type GatewayCompileResponse,
  type ProjectSnapshot,
  type SynctexCodeQuery,
} from '@kaxolax/contracts'
import { importZip } from '@kaxolax/zip-importer'
import app from '@adonisjs/core/services/app'
import testUtils from '@adonisjs/core/services/test_utils'
import { test } from '@japa/runner'
import { DateTime } from 'luxon'
import { type ApiClient, ApiRequest } from '@japa/api-client'
import Compile from '#models/compile'
import Document from '#models/document'
import File from '#models/file'
import Project from '#models/project'
import ProjectMember from '#models/project_member'
import type User from '#models/user'
import CompileGateway, {
  CompileServiceUnavailableException,
  NoCompileOutputException,
} from '#services/compile_gateway'
import ObjectStorage, { CompileOutputStorage } from '#services/object_storage'
import RealtimeClient from '#services/realtime_client'
import { createUser } from '#tests/helpers'

// Le zip exporté est lu comme un Buffer.
ApiRequest.addParser('application/zip', (response, done) => {
  const chunks: Buffer[] = []
  response.on('data', (chunk: Buffer) => chunks.push(chunk))
  response.on('end', () => {
    done(null, Buffer.concat(chunks))
  })
})

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 9, 9])
const sha256 = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')

/** Faux gateway : enregistre les demandes et répond comme un agent (sorties écrites dans S3). */
class FakeGateway extends CompileGateway {
  requests: CompileRequest[] = []
  unavailable = false
  synctexQueries: SynctexCodeQuery[] = []
  hasOutput = true

  override async compile(request: CompileRequest): Promise<GatewayCompileResponse> {
    this.requests.push(request)
    if (this.unavailable) throw new CompileServiceUnavailableException()
    const outputs = new CompileOutputStorage()
    await outputs.putBuffer(
      `${request.output.prefix}output.pdf`,
      Buffer.from('%PDF-1.7 fake'),
      'application/pdf',
    )
    await outputs.putBuffer(
      `${request.output.prefix}output.log`,
      Buffer.from('This is pdfTeX'),
      'text/plain',
    )
    return {
      buildId: request.buildId,
      status: 'failure',
      durationMs: 1234,
      agentId: 'agent-test',
      outputFiles: [
        { name: 'output.pdf', s3Key: `${request.output.prefix}output.pdf`, sizeBytes: 13 },
        { name: 'output.log', s3Key: `${request.output.prefix}output.log`, sizeBytes: 14 },
      ],
      entries: [
        {
          level: 'error',
          file: 'chapters/intro.tex',
          line: 3,
          message: 'Undefined control sequence',
          raw: '! Undefined',
        },
      ],
      timings: { syncMs: 1, runMs: 1200, uploadMs: 33 },
    }
  }

  override async synctexFromPdf() {
    return Promise.resolve({
      code: [
        { file: 'output.bbl', line: 2, column: 0 },
        { file: 'chapters/intro.tex', line: 3, column: 0 },
        { file: 'chapters/intro.tex', line: 3, column: 0 },
        { file: 'main.tex', line: 7, column: 0 },
      ],
    })
  }

  override async stop() {
    return Promise.resolve(true)
  }

  override async clearCache() {
    return Promise.resolve(true)
  }

  override async synctexFromCode(_projectId: string, query: SynctexCodeQuery) {
    this.synctexQueries.push(query)
    if (!this.hasOutput) throw new NoCompileOutputException()
    return Promise.resolve({ pdf: [{ page: 2, h: 72, v: 144, width: 400, height: 10 }] })
  }
}

/** Faux service temps réel : instantané configurable, ou indisponible (null). */
class FakeRealtime extends RealtimeClient {
  snapshots = new Map<string, ProjectSnapshot | null>()

  override async snapshot(projectId: string) {
    return Promise.resolve(this.snapshots.get(projectId) ?? null)
  }

  override async closeDocuments() {
    return Promise.resolve()
  }
}

let gateway: FakeGateway
let realtime: FakeRealtime

async function setupProject(client: ApiClient, user: User) {
  const created = await client.post('/api/v1/projects').json({ name: 'Thèse' }).loginAs(user)
  const projectId = created.body().project.id as string
  const folder = await client
    .post(`/api/v1/projects/${projectId}/folders`)
    .json({ name: 'chapters' })
    .loginAs(user)
  const intro = await client
    .post(`/api/v1/projects/${projectId}/documents`)
    .json({ name: 'intro.tex', folderId: folder.body().folder.id, content: 'stored intro' })
    .loginAs(user)
  await client.post(`/api/v1/projects/${projectId}/folders`).json({ name: 'empty' }).loginAs(user)
  // Un binaire directement en base et dans S3 (le parcours d'upload est testé ailleurs).
  const storage = new ObjectStorage()
  const fileId = randomUUID()
  const key = `projects/${projectId}/files/${fileId}`
  await storage.putBuffer(key, PNG, 'image/png')
  await File.create({
    id: fileId,
    projectId,
    folderId: null,
    name: 'plot.png',
    s3Key: key,
    sha256: sha256(PNG),
    sizeBytes: PNG.length,
    mimeType: 'image/png',
  })
  const project = await Project.findOrFail(projectId)
  return {
    projectId,
    introId: intro.body().document.id as string,
    mainId: project.mainDocumentId ?? '',
  }
}

test.group('compile', (group) => {
  group.each.setup(() => testUtils.db().wrapInGlobalTransaction())
  group.each.setup(() => {
    gateway = new FakeGateway()
    realtime = new FakeRealtime()
    app.container.swap(CompileGateway, () => gateway)
    app.container.swap(RealtimeClient, () => realtime)
    return () => {
      app.container.restore(CompileGateway)
      app.container.restore(RealtimeClient)
    }
  })

  test('builds the request from the realtime snapshot and the files table', async ({
    client,
    assert,
  }) => {
    const user = await createUser()
    const { projectId, introId, mainId } = await setupProject(client, user)
    // L'instantané contient la version en cours d'édition de main.tex ; intro.tex vient de la base.
    realtime.snapshots.set(projectId, {
      projectId,
      documents: [{ id: mainId, content: 'live main', sha256: sha256('live main') }],
    })
    const before = await Project.findOrFail(projectId)

    const response = await client.post(`/api/v1/projects/${projectId}/compile`).loginAs(user)
    response.assertStatus(200)
    const result = compileResultSchema.parse(response.body())

    const [request] = gateway.requests
    assert.equal(request?.rootResourcePath, 'main.tex')
    assert.equal(request?.compiler, 'pdflatex')
    assert.equal(request?.output.prefix, `outputs/${projectId}/${result.buildId}/`)
    assert.sameDeepMembers(request?.resources ?? [], [
      { path: 'main.tex', kind: 'text', content: 'live main', sha256: sha256('live main') },
      {
        path: 'chapters/intro.tex',
        kind: 'text',
        content: 'stored intro',
        sha256: sha256('stored intro'),
      },
      {
        path: 'plot.png',
        kind: 'binary',
        s3Key: (await File.findByOrFail('projectId', projectId)).s3Key,
        sha256: sha256(PNG),
      },
    ])
    assert.notEqual(introId, mainId)

    assert.equal(result.status, 'failure')
    assert.deepEqual(result.entries[0], {
      level: 'error',
      file: 'chapters/intro.tex',
      line: 3,
      message: 'Undefined control sequence',
      raw: '! Undefined',
    })
    assert.equal(await (await fetch(result.pdfUrl ?? '')).text(), '%PDF-1.7 fake')
    assert.equal(await (await fetch(result.logUrl ?? '')).text(), 'This is pdfTeX')

    const compile = await Compile.findOrFail(result.buildId)
    assert.include(compile.$attributes, {
      status: 'failure',
      durationMs: 1234,
      agentId: 'agent-test',
      userId: user.id,
    })
    const after = await Project.findOrFail(projectId)
    assert.isNotNull(after.lastCompiledAt)
    assert.equal(after.updatedAt.toMillis(), before.updatedAt.toMillis())
  })

  test('shows the last compile when the project is opened again', async ({ client, assert }) => {
    const user = await createUser()
    const { projectId } = await setupProject(client, user)
    const empty = await client.get(`/api/v1/projects/${projectId}/compile/last`).loginAs(user)
    empty.assertBody({ compile: null })

    const compiled = await client.post(`/api/v1/projects/${projectId}/compile`).loginAs(user)
    const last = await client.get(`/api/v1/projects/${projectId}/compile/last`).loginAs(user)
    const result = compileResultSchema.parse(last.body().compile)
    assert.equal(result.buildId, compiled.body().buildId)
    assert.equal(result.entries[0]?.message, 'Undefined control sequence')
    assert.equal(await (await fetch(result.pdfUrl ?? '')).text(), '%PDF-1.7 fake')

    // Sorties expirées (7 jours) : la compilation reste, sans URL.
    await new CompileOutputStorage().deletePrefix(`outputs/${projectId}/`)
    const expired = await client.get(`/api/v1/projects/${projectId}/compile/last`).loginAs(user)
    assert.deepInclude(expired.body().compile, { pdfUrl: null, logUrl: null, entries: [] })
  })

  test('records an error when no compile agent is available', async ({ client, assert }) => {
    const user = await createUser()
    const { projectId } = await setupProject(client, user)
    gateway.unavailable = true
    const response = await client.post(`/api/v1/projects/${projectId}/compile`).loginAs(user)
    response.assertStatus(200)
    const result = compileResultSchema.parse(response.body())
    assert.equal(result.status, 'error')
    assert.isNull(result.pdfUrl)
    assert.lengthOf(result.entries, 1)
    assert.equal((await Compile.findOrFail(result.buildId)).status, 'error')
  })

  test('uses stored content when the realtime service is down, and requires a main document', async ({
    client,
    assert,
  }) => {
    const user = await createUser()
    const { projectId, mainId } = await setupProject(client, user)
    await client.post(`/api/v1/projects/${projectId}/compile`).loginAs(user)
    const main = gateway.requests[0]?.resources.find((resource) => resource.path === 'main.tex')
    const stored = await Document.findOrFail(mainId)
    assert.equal(main?.kind, 'text')
    assert.include(main?.kind === 'text' ? main.content : '', '\\documentclass')
    assert.isNotNull(stored.contentSha256)

    await Project.query().where('id', projectId).update({ mainDocumentId: null })
    const response = await client.post(`/api/v1/projects/${projectId}/compile`).loginAs(user)
    response.assertStatus(422)
    response.assertBodyContains({ code: 'E_NO_MAIN_DOCUMENT' })
  })

  test('relays stop, clear cache and SyncTeX, and validates SyncTeX queries', async ({
    client,
    assert,
  }) => {
    const user = await createUser()
    const { projectId } = await setupProject(client, user)
    const base = `/api/v1/projects/${projectId}`
    ;(await client.post(`${base}/compile/stop`).loginAs(user)).assertBody({
      stopped: true,
    })
    ;(await client.post(`${base}/compile/clear-cache`).loginAs(user)).assertBody({
      cleared: true,
    })

    const synctex = await client
      .get(`${base}/synctex/code`)
      .qs({ file: 'chapters/intro.tex', line: '3' })
      .loginAs(user)
    synctex.assertStatus(200)
    synctex.assertBody({ pdf: [{ page: 2, h: 72, v: 144, width: 400, height: 10 }] })
    assert.deepEqual(gateway.synctexQueries, [{ file: 'chapters/intro.tex', line: 3, column: 0 }])
    ;(
      await client
        .get(`${base}/synctex/code`)
        .qs({ file: '../etc/passwd', line: '1' })
        .loginAs(user)
    ).assertStatus(422)
    ;(
      await client.get(`${base}/synctex/pdf`).qs({ page: '0', h: '1', v: '1' }).loginAs(user)
    ).assertStatus(422)
    // Les fichiers générés (output.bbl) et les doublons sont écartés.
    const reverse = await client
      .get(`${base}/synctex/pdf`)
      .qs({ page: '1', h: '72.5', v: '300' })
      .loginAs(user)
    reverse.assertBody({
      code: [
        { file: 'chapters/intro.tex', line: 3, column: 0 },
        { file: 'main.tex', line: 7, column: 0 },
      ],
    })

    gateway.hasOutput = false
    const missing = await client
      .get(`${base}/synctex/code`)
      .qs({ file: 'main.tex', line: '1' })
      .loginAs(user)
    missing.assertStatus(404)
    missing.assertBodyContains({ code: 'E_NO_COMPILE_OUTPUT' })

    const stranger = await createUser()
    ;(await client.post(`${base}/compile`).loginAs(stranger)).assertStatus(404)
  })
})

test.group('export', (group) => {
  group.each.setup(() => testUtils.db().wrapInGlobalTransaction())
  group.each.setup(() => {
    realtime = new FakeRealtime()
    app.container.swap(RealtimeClient, () => realtime)
    return () => {
      app.container.restore(RealtimeClient)
    }
  })

  test('streams a zip that imports back into the same project tree', async ({ client, assert }) => {
    const user = await createUser()
    const { projectId, mainId } = await setupProject(client, user)
    realtime.snapshots.set(projectId, {
      projectId,
      documents: [{ id: mainId, content: '\\documentclass{article}\n% live', sha256: sha256('x') }],
    })
    const response = await client.get(`/api/v1/projects/${projectId}/download.zip`).loginAs(user)
    response.assertStatus(200)
    assert.equal(response.header('content-type'), 'application/zip')
    assert.include(response.header('content-disposition') ?? '', 'attachment')

    const path = join(tmpdir(), `kaxolax-export-${projectId}.zip`)
    await writeFile(path, response.body() as Buffer)
    try {
      const stored = new Map<string, Buffer>()
      const plan = await importZip(path, async ({ path: file, body }) => {
        stored.set(file, Buffer.concat(await body.toArray()))
        return file
      })
      assert.sameMembers(plan.folders, ['chapters', 'empty'])
      assert.sameDeepMembers(
        plan.documents.map(({ path: file, content }) => ({ file, content })),
        [
          { file: 'main.tex', content: '\\documentclass{article}\n% live' },
          { file: 'chapters/intro.tex', content: 'stored intro' },
        ],
      )
      assert.deepEqual(stored.get('plot.png'), PNG)
      assert.equal(plan.mainDocumentPath, 'main.tex')
    } finally {
      await rm(path, { force: true })
    }
  })

  test('downloads the zip through a short signed link, role checked again', async ({
    client,
    assert,
  }) => {
    const user = await createUser()
    const stranger = await createUser()
    const { projectId } = await setupProject(client, user)

    const link = await client.post(`/api/v1/projects/${projectId}/download-url`).loginAs(user)
    link.assertStatus(200)
    const url = String(link.body().url)
    assert.match(url, /^\/api\/v1\/downloads\/[^/]+$/)
    assert.isAbove(new Date(String(link.body().expiresAt)).getTime(), Date.now() + 50_000)

    // Simple navigation, sans en-tête Authorization.
    const downloaded = await client.get(url)
    downloaded.assertStatus(200)
    assert.equal(downloaded.header('content-type'), 'application/zip')

    // Lien modifié ou d'un autre usage : refusé.
    ;(await client.get(`${url.slice(0, -6)}AAAAAA`)).assertStatus(410)
    ;(await client.get('/api/v1/downloads/not-a-token')).assertStatus(410)

    // Pas de lien pour un non-membre ; un membre retiré après l'émission ne télécharge plus.
    ;(
      await client.post(`/api/v1/projects/${projectId}/download-url`).loginAs(stranger)
    ).assertStatus(404)
    await ProjectMember.create({ projectId, userId: stranger.id, role: 'viewer' })
    const theirs = await client.post(`/api/v1/projects/${projectId}/download-url`).loginAs(stranger)
    theirs.assertStatus(200)
    await ProjectMember.query().where({ projectId, userId: stranger.id }).delete()
    ;(await client.get(String(theirs.body().url))).assertStatus(404)

    // Compte banni après l'émission du lien : le lien ne sert plus.
    const mine = await client.post(`/api/v1/projects/${projectId}/download-url`).loginAs(user)
    mine.assertStatus(200)
    user.bannedAt = DateTime.utc()
    await user.save()
    ;(await client.get(String(mine.body().url))).assertStatus(410)
  })
})
