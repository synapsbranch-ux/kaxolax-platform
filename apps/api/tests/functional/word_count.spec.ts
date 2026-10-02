import { createHash } from 'node:crypto'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import {
  verifyCompileWorkerToken,
  type WordCountRequest,
  type WordCountResult,
  wordCountResponseSchema,
} from '@kaxolax/contracts'
import { Secret } from '@adonisjs/core/helpers'
import app from '@adonisjs/core/services/app'
import testUtils from '@adonisjs/core/services/test_utils'
import { test } from '@japa/runner'
import type { ApiClient, ApiResponse } from '@japa/api-client'
import compileConfig from '#config/compile'
import Project from '#models/project'
import ProjectMember from '#models/project_member'
import type User from '#models/user'
import CompileGateway, {
  CompileServiceUnavailableException,
  WordCountFailedException,
} from '#services/compile_gateway'
import RealtimeClient from '#services/realtime_client'
import { createUser } from '#tests/helpers'

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex')
const SECRET = 'test-compile-worker-secret-0123456789abcdef'

const counts = {
  words: 12,
  text: 9,
  headers: 2,
  captions: 1,
  headerCount: 2,
  floatCount: 1,
  inlineMathCount: 0,
  displayMathCount: 0,
}
const RESULT: WordCountResult = {
  total: counts,
  sections: [{ ...counts, kind: 'section', title: 'Introduction' }],
  warnings: ['File absent.tex not found in path [./].'],
}

/** Faux gateway : enregistre les demandes de comptage, répond comme l'agent (ou échoue). */
class FakeGateway extends CompileGateway {
  requests: WordCountRequest[] = []
  failure: Error | null = null
  /** Comptages retenus jusqu'à sa résolution. */
  gate: Promise<void> | null = null

  override async wordCount(request: WordCountRequest): Promise<WordCountResult> {
    this.requests.push(request)
    if (this.gate) await this.gate
    if (this.failure) throw this.failure
    return Promise.resolve(RESULT)
  }
}

/** Faux service temps réel : aucun instantané (texte enregistré en base). */
class FakeRealtime extends RealtimeClient {
  override async snapshot() {
    return Promise.resolve(null)
  }
}

let gateway: FakeGateway

async function setupProject(client: ApiClient, user: User) {
  const created = await client.post('/api/v1/projects').json({ name: 'Mots' }).loginAs(user)
  const projectId = created.body().project.id as string
  const folder = await client
    .post(`/api/v1/projects/${projectId}/folders`)
    .json({ name: 'chapters' })
    .loginAs(user)
  const intro = await client
    .post(`/api/v1/projects/${projectId}/documents`)
    .json({ name: 'intro.tex', folderId: folder.body().folder.id, content: 'Bonjour.' })
    .loginAs(user)
  await client
    .post(`/api/v1/projects/${projectId}/documents`)
    .json({ name: 'refs.bib', content: '@book{a, title={T}}' })
    .loginAs(user)
  return { projectId, introId: intro.body().document.id as string }
}

test.group('word count', (group) => {
  group.each.setup(() => testUtils.db().wrapInGlobalTransaction())
  group.each.setup(() => {
    gateway = new FakeGateway()
    app.container.swap(CompileGateway, () => gateway)
    app.container.swap(RealtimeClient, () => new FakeRealtime())
    return () => {
      app.container.restore(CompileGateway)
      app.container.restore(RealtimeClient)
    }
  })

  test('counts the main document with the .tex documents only', async ({ client, assert }) => {
    const user = await createUser()
    const { projectId } = await setupProject(client, user)
    const response = await client.post(`/api/v1/projects/${projectId}/word-count`).loginAs(user)
    response.assertStatus(200)
    const body = wordCountResponseSchema.parse(response.body())
    assert.deepInclude(body, { ...RESULT, rootResourcePath: 'main.tex' })

    const [request] = gateway.requests
    assert.equal(request?.projectId, projectId)
    assert.equal(request?.rootResourcePath, 'main.tex')
    assert.sameMembers(request?.resources.map((resource) => resource.path) ?? [], [
      'main.tex',
      'chapters/intro.tex',
    ])
    const intro = request?.resources.find((resource) => resource.path === 'chapters/intro.tex')
    assert.deepEqual(intro, {
      path: 'chapters/intro.tex',
      kind: 'text',
      content: 'Bonjour.',
      sha256: sha256('Bonjour.'),
    })
  })

  test('counts another document on request', async ({ client, assert }) => {
    const user = await createUser()
    const { projectId, introId } = await setupProject(client, user)
    const response = await client
      .post(`/api/v1/projects/${projectId}/word-count`)
      .json({ documentId: introId })
      .loginAs(user)
    response.assertStatus(200)
    assert.equal(response.body().rootResourcePath, 'chapters/intro.tex')
    assert.equal(gateway.requests[0]?.rootResourcePath, 'chapters/intro.tex')

    const unknown = await client
      .post(`/api/v1/projects/${projectId}/word-count`)
      .json({ documentId: '0b8f7e6d-5c4b-4a39-8281-7f6e5d4c3b2a' })
      .loginAs(user)
    unknown.assertStatus(404)
    const invalid = await client
      .post(`/api/v1/projects/${projectId}/word-count`)
      .json({ documentId: introId, other: true })
      .loginAs(user)
    invalid.assertStatus(422)
  })

  test('is open to viewers, hidden from non-members', async ({ client }) => {
    const owner = await createUser()
    const viewer = await createUser()
    const stranger = await createUser()
    const { projectId } = await setupProject(client, owner)
    await ProjectMember.create({ projectId, userId: viewer.id, role: 'viewer' })
    ;(await client.post(`/api/v1/projects/${projectId}/word-count`).loginAs(viewer)).assertStatus(
      200,
    )
    ;(await client.post(`/api/v1/projects/${projectId}/word-count`).loginAs(stranger)).assertStatus(
      404,
    )
    ;(await client.post(`/api/v1/projects/${projectId}/word-count`)).assertStatus(401)
  })

  test('runs one count per user and project, and a bounded number per user', async ({
    client,
    assert,
  }) => {
    const user = await createUser()
    const { projectId, introId } = await setupProject(client, user)
    const second = await setupProject(client, user)
    const third = await setupProject(client, user)
    let open: () => void = () => undefined
    gateway.gate = new Promise<void>((resolve) => {
      open = resolve
    })
    const url = (id: string) => `/api/v1/projects/${id}/word-count`
    // Requête envoyée tout de suite (le client de Japa n'envoie qu'au premier `then`).
    const start = (request: PromiseLike<ApiResponse>) => Promise.resolve(request)
    const waitForRequests = async (count: number) => {
      while (gateway.requests.length < count) await new Promise((r) => setTimeout(r, 5))
    }

    const first = start(client.post(url(projectId)).loginAs(user))
    await waitForRequests(1)
    // Même document : la demande attend le comptage en cours, sans second appel à l'agent.
    const same = start(client.post(url(projectId)).loginAs(user))
    // Autre document du même projet : 429.
    const other = await client.post(url(projectId)).json({ documentId: introId }).loginAs(user)
    other.assertStatus(429)
    assert.equal(other.body().code, 'E_WORD_COUNT_BUSY')
    // Deuxième projet accepté, troisième refusé (MAX_WORD_COUNTS_PER_USER = 2).
    const secondCount = start(client.post(url(second.projectId)).loginAs(user))
    await waitForRequests(2)
    ;(await client.post(url(third.projectId)).loginAs(user)).assertStatus(429)
    // Un autre utilisateur n'est pas concerné par la borne.
    const someoneElse = await createUser()
    const theirs = await setupProject(client, someoneElse)
    const theirCount = start(client.post(url(theirs.projectId)).loginAs(someoneElse))
    await waitForRequests(3)
    // Laisse la demande `same` atteindre le comptage en cours.
    await new Promise((r) => setTimeout(r, 100))

    open()
    const responses = await Promise.all([first, same, secondCount, theirCount])
    for (const response of responses) response.assertStatus(200)
    assert.lengthOf(gateway.requests, 3)
    // Comptages terminés : de nouveau acceptés.
    gateway.gate = null
    ;(await client.post(url(third.projectId)).loginAs(user)).assertStatus(200)
    ;(await client.post(url(projectId)).json({ documentId: introId }).loginAs(user)).assertStatus(
      200,
    )
  })

  test('reports a missing main document, a texcount failure and an unavailable service', async ({
    client,
    assert,
  }) => {
    const user = await createUser()
    const { projectId } = await setupProject(client, user)

    gateway.failure = new WordCountFailedException('Word count timed out')
    const failed = await client.post(`/api/v1/projects/${projectId}/word-count`).loginAs(user)
    failed.assertStatus(422)
    assert.include(failed.body(), { code: 'E_WORD_COUNT_FAILED', message: 'Word count timed out' })

    gateway.failure = new CompileServiceUnavailableException()
    const unavailable = await client.post(`/api/v1/projects/${projectId}/word-count`).loginAs(user)
    unavailable.assertStatus(503)
    assert.equal(unavailable.body().code, 'E_COMPILE_UNAVAILABLE')

    gateway.failure = null
    const project = await Project.findOrFail(projectId)
    project.mainDocumentId = null
    await project.save()
    const noMain = await client.post(`/api/v1/projects/${projectId}/word-count`).loginAs(user)
    noMain.assertStatus(422)
    assert.equal(noMain.body().code, 'E_NO_MAIN_DOCUMENT')
    assert.lengthOf(gateway.requests, 2)
  })
})

/** Faux Worker : vérifie le jeton du projet, renvoie un résultat ou l'échec de texcount. */
class FakeWorker {
  requests: unknown[] = []
  status = 200
  server: Server = createServer((request, response) => {
    void this.handle(request).then(({ status, body }) => {
      response.writeHead(status, { 'content-type': 'application/json' })
      response.end(JSON.stringify(body))
    })
  })

  async start(): Promise<string> {
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve))
    return `http://127.0.0.1:${String((this.server.address() as AddressInfo).port)}`
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) =>
      this.server.close(() => {
        resolve()
      }),
    )
  }

  private async handle(request: IncomingMessage) {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(chunk as Buffer)
    const match = /^\/projects\/([^/]+)\/word-count$/.exec(request.url ?? '')
    const token = (request.headers.authorization ?? '').replace(/^Bearer /, '')
    const claims = await verifyCompileWorkerToken(token, SECRET)
    if (!match || claims?.projectId !== match[1]) return { status: 401, body: {} }
    this.requests.push(JSON.parse(Buffer.concat(chunks).toString('utf8')))
    if (this.status === 422) {
      return { status: 422, body: { error: 'word_count_failed', message: 'Word count timed out' } }
    }
    return { status: this.status, body: RESULT }
  }
}

test.group('word count (cloudflare)', (group) => {
  const saved = { ...compileConfig }
  let worker: FakeWorker
  group.each.setup(() => testUtils.db().wrapInGlobalTransaction())
  group.each.setup(async () => {
    worker = new FakeWorker()
    compileConfig.backend = 'cloudflare'
    compileConfig.workerUrl = await worker.start()
    compileConfig.workerSecret = new Secret(SECRET)
    app.container.swap(RealtimeClient, () => new FakeRealtime())
    return async () => {
      Object.assign(compileConfig, saved)
      app.container.restore(RealtimeClient)
      await worker.stop()
    }
  })

  test('goes through the worker of the project', async ({ client, assert }) => {
    const user = await createUser()
    const { projectId } = await setupProject(client, user)
    const response = await client.post(`/api/v1/projects/${projectId}/word-count`).loginAs(user)
    response.assertStatus(200)
    assert.deepInclude(response.body(), { total: counts, rootResourcePath: 'main.tex' })
    assert.lengthOf(worker.requests, 1)
    assert.include(worker.requests[0], { projectId, rootResourcePath: 'main.tex' })

    worker.status = 422
    const failed = await client.post(`/api/v1/projects/${projectId}/word-count`).loginAs(user)
    failed.assertStatus(422)
    assert.equal(failed.body().message, 'Word count timed out')

    worker.status = 500
    const broken = await client.post(`/api/v1/projects/${projectId}/word-count`).loginAs(user)
    broken.assertStatus(503)
  })
})
