import { randomUUID } from 'node:crypto'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import { type AddressInfo } from 'node:net'
import {
  buildStateSchema,
  type CompileUpdatedEvent,
  compileRequestSchema,
  type ProjectEvent,
  signCallback,
  verifyCompileWorkerToken,
  type WorkerCallback,
} from '@kaxolax/contracts'
import { Secret } from '@adonisjs/core/helpers'
import app from '@adonisjs/core/services/app'
import testUtils from '@adonisjs/core/services/test_utils'
import db from '@adonisjs/lucid/services/db'
import { test } from '@japa/runner'
import { type ApiClient } from '@japa/api-client'
import compileConfig from '#config/compile'
import Compile from '#models/compile'
import ProjectMember from '#models/project_member'
import type User from '#models/user'
import { noResponseEntry } from '#services/async_compile_service'
import { CompileOutputStorage } from '#services/object_storage'
import RealtimeClient from '#services/realtime_client'
import { createUser } from '#tests/helpers'

const SECRET = 'test-compile-worker-secret-0123456789abcdef'

interface WorkerCall {
  method: string
  path: string
  projectId: string | null
  body: unknown
}

/**
 * Faux Worker Cloudflare (serveur HTTP local) : vérifie le jeton HMAC de chaque appel, enregistre
 * les demandes et répond comme le vrai Worker.
 */
class FakeWorker {
  calls: WorkerCall[] = []
  unavailable = false
  /** Réponse du Durable Object : `preparing` quand le conteneur se réveille. */
  enqueueStatus: 'queued' | 'preparing' = 'queued'
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

  calledOn(path: string) {
    return this.calls.filter((call) => call.path === path)
  }

  private async handle(request: IncomingMessage): Promise<{ status: number; body: unknown }> {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(chunk as Buffer)
    const raw = Buffer.concat(chunks).toString('utf8')
    const url = new URL(request.url ?? '/', 'http://worker')
    const match = /^\/projects\/([^/]+)(\/.*)$/.exec(url.pathname)
    const token = (request.headers.authorization ?? '').replace(/^Bearer /, '')
    const claims = await verifyCompileWorkerToken(token, SECRET)
    if (!match || claims?.projectId !== match[1]) return { status: 401, body: {} }
    const path = match[2] ?? ''
    this.calls.push({
      method: request.method ?? '',
      path,
      projectId: match[1] ?? null,
      body: raw === '' ? Object.fromEntries(url.searchParams) : (JSON.parse(raw) as unknown),
    })
    if (this.unavailable) return { status: 503, body: {} }
    if (path === '/compile') {
      const job = JSON.parse(raw) as { buildId: string }
      return { status: 202, body: { buildId: job.buildId, status: this.enqueueStatus } }
    }
    if (path === '/synctex/code') return { status: 200, body: { pdf: [] } }
    if (path === '/synctex/pdf') {
      return { status: 200, body: { code: [{ file: 'main.tex', line: 4, column: 0 }] } }
    }
    if (path === '/clear-cache') return { status: 200, body: { cleared: true } }
    return { status: 202, body: { ok: true } }
  }
}

/** Faux service temps réel : garde les événements de compilation publiés, avec leur projet. */
class FakeRealtime extends RealtimeClient {
  published: (CompileUpdatedEvent & { projectId: string })[] = []

  override async snapshot() {
    return Promise.resolve(null)
  }

  override async publishProjectEvent(projectId: string, event: ProjectEvent) {
    if (event.type === 'compile.updated') this.published.push({ projectId, ...event })
    return Promise.resolve()
  }
}

let worker: FakeWorker
let realtime: FakeRealtime
const saved = { ...compileConfig }

async function newProject(client: ApiClient, user: User): Promise<string> {
  const created = await client.post('/api/v1/projects').json({ name: 'Async' }).loginAs(user)
  return created.body().project.id as string
}

/** Rappel signé comme par le Worker. */
async function callback(client: ApiClient, body: WorkerCallback, secret = SECRET, now?: number) {
  const headers = await signCallback(JSON.stringify(body), secret, now)
  return client.post('/api/v1/internal/compile-callbacks').headers(headers).json(body)
}

async function writeOutputs(projectId: string, buildId: string) {
  const outputs = new CompileOutputStorage()
  const prefix = `outputs/${projectId}/${buildId}/`
  await outputs.putBuffer(`${prefix}output.pdf`, Buffer.from('%PDF-1.7 async'), 'application/pdf')
  await outputs.putBuffer(`${prefix}output.log`, Buffer.from('This is LuaHBTeX'), 'text/plain')
  return [
    { name: 'output.pdf', s3Key: `${prefix}output.pdf`, sizeBytes: 14 },
    { name: 'output.log', s3Key: `${prefix}output.log`, sizeBytes: 16 },
  ]
}

test.group('compile (cloudflare, asynchronous)', (group) => {
  group.each.setup(() => testUtils.db().wrapInGlobalTransaction())
  group.each.setup(async () => {
    worker = new FakeWorker()
    realtime = new FakeRealtime()
    compileConfig.backend = 'cloudflare'
    compileConfig.workerUrl = await worker.start()
    compileConfig.workerSecret = new Secret(SECRET)
    app.container.swap(RealtimeClient, () => realtime)
    return async () => {
      Object.assign(compileConfig, saved)
      app.container.restore(RealtimeClient)
      await worker.stop()
    }
  })

  test('queues the build, stores the request in R2 and hands it to the worker', async ({
    client,
    assert,
  }) => {
    const user = await createUser()
    const projectId = await newProject(client, user)

    const response = await client.post(`/api/v1/projects/${projectId}/compile`).loginAs(user)
    response.assertStatus(202)
    const buildId = String(response.body().buildId)
    response.assertBody({ buildId, status: 'queued' })

    const [call] = worker.calledOn('/compile')
    assert.deepEqual(call?.body, {
      projectId,
      buildId,
      requestKey: `outputs/${projectId}/${buildId}/request.json`,
    })
    const stored = await new CompileOutputStorage().read(
      `outputs/${projectId}/${buildId}/request.json`,
    )
    const request = compileRequestSchema.parse(
      JSON.parse(Buffer.concat(await stored.toArray()).toString('utf8')),
    )
    assert.equal(request.buildId, buildId)
    assert.equal(request.rootResourcePath, 'main.tex')
    // Durée maximale du plan du propriétaire (Free : 20 s), calculée par l'API.
    assert.equal(request.timeoutMs, 20_000)

    const compile = await Compile.findOrFail(buildId)
    assert.include(compile.$attributes, {
      status: 'queued',
      backend: 'cloudflare',
      userId: user.id,
    })
    assert.deepEqual(realtime.published, [
      { type: 'compile.updated', projectId, buildId, status: 'queued', result: null },
    ])

    const state = await client.get(`/api/v1/projects/${projectId}/builds/${buildId}`).loginAs(user)
    state.assertStatus(200)
    assert.include(buildStateSchema.parse(state.body().build), { status: 'queued', result: null })
  })

  test('allows one build at a time per project', async ({ client, assert }) => {
    const user = await createUser()
    const projectId = await newProject(client, user)
    const first = await client.post(`/api/v1/projects/${projectId}/compile`).loginAs(user)
    const second = await client.post(`/api/v1/projects/${projectId}/compile`).loginAs(user)
    second.assertStatus(409)
    second.assertBodyContains({ code: 'E_COMPILE_IN_PROGRESS', buildId: first.body().buildId })
    assert.lengthOf(worker.calledOn('/compile'), 1)

    // Une compilation restée sans nouvelles au-delà de son timeout et de la marge est close.
    await Compile.query()
      .where('id', String(first.body().buildId))
      .update({ createdAt: '2026-01-01T00:00:00Z' })
    const third = await client.post(`/api/v1/projects/${projectId}/compile`).loginAs(user)
    third.assertStatus(202)
    assert.equal((await Compile.findOrFail(String(first.body().buildId))).status, 'error')
  })

  test('announces the compiler wake-up when the container is starting', async ({
    client,
    assert,
  }) => {
    const user = await createUser()
    const projectId = await newProject(client, user)
    worker.enqueueStatus = 'preparing'

    const response = await client.post(`/api/v1/projects/${projectId}/compile`).loginAs(user)
    response.assertStatus(202)
    const buildId = String(response.body().buildId)
    response.assertBody({ buildId, status: 'preparing' })
    assert.equal((await Compile.findOrFail(buildId)).status, 'preparing')

    // Le rappel `preparing` du Worker ne répète pas l'événement ; `running` le suit.
    const base = { projectId, buildId }
    ;(await callback(client, { ...base, seq: 1, status: 'preparing' })).assertBody({
      applied: true,
    })
    ;(await callback(client, { ...base, seq: 2, status: 'running' })).assertBody({ applied: true })
    assert.deepEqual(
      realtime.published.map((event) => event.status),
      ['queued', 'preparing', 'running'],
    )
  })

  test('closes a build lost by the worker when it is polled', async ({ client, assert }) => {
    const user = await createUser()
    const projectId = await newProject(client, user)
    const queued = await client.post(`/api/v1/projects/${projectId}/compile`).loginAs(user)
    const buildId = String(queued.body().buildId)
    const url = `/api/v1/projects/${projectId}/builds/${buildId}`

    // Encore dans les temps : toujours active.
    assert.equal((await client.get(url).loginAs(user)).body().build.status, 'queued')

    // Sans nouvelles au-delà du timeout et de la marge : close en erreur, événement publié.
    await Compile.query().where('id', buildId).update({ createdAt: '2026-01-01T00:00:00Z' })
    const state = await client.get(url).loginAs(user)
    state.assertStatus(200)
    assert.equal(state.body().build.status, 'error')
    assert.isNotNull(state.body().build.finishedAt)
    // Le panneau des logs explique l'erreur, dans la réponse comme dans l'événement.
    const entries = [noResponseEntry()]
    assert.deepEqual(state.body().build.result.entries, entries)
    const published = realtime.published.at(-1)
    assert.include(published, { type: 'compile.updated', projectId, buildId, status: 'error' })
    assert.deepEqual(published?.result?.entries, entries)
    assert.equal(published?.result?.status, 'error')
  })

  test('applies signed callbacks once, in order, and pushes the result', async ({
    client,
    assert,
  }) => {
    const user = await createUser()
    const projectId = await newProject(client, user)
    const queued = await client.post(`/api/v1/projects/${projectId}/compile`).loginAs(user)
    const buildId = String(queued.body().buildId)
    const base = { projectId, buildId }

    ;(await callback(client, { ...base, seq: 1, status: 'preparing' })).assertBody({
      applied: true,
    })
    ;(await callback(client, { ...base, seq: 2, status: 'running', agentId: 'cf-1' })).assertBody({
      applied: true,
    })
    // Rejoué ou arrivé dans le désordre : ignoré.
    ;(await callback(client, { ...base, seq: 1, status: 'preparing' })).assertBody({
      applied: false,
    })
    assert.equal((await Compile.findOrFail(buildId)).status, 'running')

    const final: WorkerCallback = {
      ...base,
      seq: 3,
      status: 'failure',
      durationMs: 2345,
      entries: [{ level: 'error', file: 'main.tex', line: 2, message: 'Oops', raw: '! Oops' }],
      outputFiles: await writeOutputs(projectId, buildId),
    }
    ;(await callback(client, final)).assertBody({ applied: true })
    ;(await callback(client, final)).assertBody({ applied: false })
    ;(await callback(client, { ...final, seq: 4, status: 'success' })).assertBody({
      applied: false,
    })

    const compile = await Compile.findOrFail(buildId)
    assert.include(compile.$attributes, {
      status: 'failure',
      durationMs: 2345,
      agentId: 'cf-1',
      lastEventSeq: 3,
    })
    assert.isNotNull(compile.finishedAt)

    const pushed = realtime.published.at(-1)
    assert.equal(pushed?.status, 'failure')
    assert.equal(pushed?.result?.entries[0]?.message, 'Oops')
    assert.equal(await (await fetch(pushed?.result?.pdfUrl ?? '')).text(), '%PDF-1.7 async')
    assert.deepEqual(
      realtime.published.map((event) => event.status),
      ['queued', 'preparing', 'running', 'failure'],
    )

    // Repli par sondage et « dernière compilation » : même résultat.
    const state = buildStateSchema.parse(
      (await client.get(`/api/v1/projects/${projectId}/builds/${buildId}`).loginAs(user)).body()
        .build,
    )
    assert.equal(state.result?.durationMs, 2345)
    assert.equal(await (await fetch(state.result?.logUrl ?? '')).text(), 'This is LuaHBTeX')
    const last = await client.get(`/api/v1/projects/${projectId}/compile/last`).loginAs(user)
    assert.equal(last.body().compile.buildId, buildId)

    // Le verrou est libéré.
    ;(await client.post(`/api/v1/projects/${projectId}/compile`).loginAs(user)).assertStatus(202)
  })

  test('refuses unsigned, stale, forged and foreign callbacks', async ({ client, assert }) => {
    const user = await createUser()
    const projectId = await newProject(client, user)
    const queued = await client.post(`/api/v1/projects/${projectId}/compile`).loginAs(user)
    const body: WorkerCallback = {
      projectId,
      buildId: String(queued.body().buildId),
      seq: 1,
      status: 'running',
    }
    ;(await client.post('/api/v1/internal/compile-callbacks').json(body)).assertStatus(401)
    ;(await callback(client, body, `${SECRET}-other`)).assertStatus(401)
    const tenMinutesAgo = Math.floor(Date.now() / 1000) - 600
    ;(await callback(client, body, SECRET, tenMinutesAgo)).assertStatus(401)
    const signed = await signCallback(JSON.stringify(body), SECRET)
    const tampered = await client
      .post('/api/v1/internal/compile-callbacks')
      .headers(signed)
      .json({ ...body, status: 'success', durationMs: 1, entries: [] })
    tampered.assertStatus(401)

    // Bonne signature, mais compilation d'un autre projet ou inconnue.
    ;(await callback(client, { ...body, projectId: randomUUID() })).assertStatus(404)
    ;(await callback(client, { ...body, buildId: randomUUID() })).assertStatus(404)
    assert.equal((await Compile.findOrFail(body.buildId)).status, 'queued')
  })

  test('stops the active build; its late result is ignored', async ({ client, assert }) => {
    const user = await createUser()
    const projectId = await newProject(client, user)
    const queued = await client.post(`/api/v1/projects/${projectId}/compile`).loginAs(user)
    const buildId = String(queued.body().buildId)

    const stop = await client.post(`/api/v1/projects/${projectId}/compile/stop`).loginAs(user)
    stop.assertBody({ stopped: true })
    assert.deepEqual(worker.calledOn('/cancel')[0]?.body, { buildId })
    assert.equal((await Compile.findOrFail(buildId)).status, 'cancelled')
    assert.equal(realtime.published.at(-1)?.status, 'cancelled')
    ;(
      await callback(client, {
        projectId,
        buildId,
        seq: 5,
        status: 'success',
        durationMs: 10,
        entries: [],
      })
    ).assertBody({ applied: false })
    ;(await client.post(`/api/v1/projects/${projectId}/compile/stop`).loginAs(user)).assertBody({
      stopped: false,
    })
    // Une compilation annulée n'a pas de résultat ; la suivante est acceptée.
    const state = await client.get(`/api/v1/projects/${projectId}/builds/${buildId}`).loginAs(user)
    assert.include(state.body().build, { status: 'cancelled', result: null })
    ;(await client.post(`/api/v1/projects/${projectId}/compile`).loginAs(user)).assertStatus(202)
  })

  test('closes the build when the worker is unavailable', async ({ client, assert }) => {
    const user = await createUser()
    const projectId = await newProject(client, user)
    worker.unavailable = true
    const response = await client.post(`/api/v1/projects/${projectId}/compile`).loginAs(user)
    response.assertStatus(503)
    response.assertBodyContains({ code: 'E_COMPILE_UNAVAILABLE' })
    const compile = await Compile.query().where('projectId', projectId).firstOrFail()
    assert.equal(compile.status, 'error')
    assert.deepEqual(
      realtime.published.map((event) => event.status),
      ['queued', 'error'],
    )
    const last = await client.get(`/api/v1/projects/${projectId}/compile/last`).loginAs(user)
    assert.equal(last.body().compile.status, 'error')
    assert.lengthOf(last.body().compile.entries, 1)
  })

  test('warms the compiler and relays SyncTeX with the last build', async ({ client, assert }) => {
    const user = await createUser()
    const projectId = await newProject(client, user)
    const base = `/api/v1/projects/${projectId}`

    const warm = await client.post(`${base}/compiler/warm`).loginAs(user)
    warm.assertStatus(202)
    warm.assertBody({ status: 'warming' })
    assert.lengthOf(worker.calledOn('/warm'), 1)

    const none = await client
      .get(`${base}/synctex/code`)
      .qs({ file: 'main.tex', line: '1' })
      .loginAs(user)
    none.assertStatus(404)
    none.assertBodyContains({ code: 'E_NO_COMPILE_OUTPUT' })

    const queued = await client.post(`${base}/compile`).loginAs(user)
    const buildId = String(queued.body().buildId)
    await callback(client, {
      projectId,
      buildId,
      seq: 1,
      status: 'success',
      durationMs: 5,
      entries: [],
      outputFiles: await writeOutputs(projectId, buildId),
    })
    ;(
      await client.get(`${base}/synctex/code`).qs({ file: 'main.tex', line: '3' }).loginAs(user)
    ).assertBody({ pdf: [] })
    assert.deepEqual(worker.calledOn('/synctex/code')[0]?.body, {
      file: 'main.tex',
      line: '3',
      column: '0',
      buildId,
    })
    ;(
      await client.get(`${base}/synctex/pdf`).qs({ page: '1', h: '1', v: '2' }).loginAs(user)
    ).assertBody({ code: [{ file: 'main.tex', line: 4, column: 0 }] })
    ;(await client.post(`${base}/compile/clear-cache`).loginAs(user)).assertBody({ cleared: true })
  })

  test('caps the compilers a user can wake up across projects', async ({ client, assert }) => {
    const user = await createUser()
    const other = await createUser()
    const limit = compileConfig.maxCompilersPerUser
    const projects: string[] = []
    for (let index = 0; index <= limit; index++) projects.push(await newProject(client, user))
    const warm = (projectId: string, as = user) =>
      client.post(`/api/v1/projects/${projectId}/compiler/warm`).loginAs(as)

    for (const projectId of projects.slice(0, limit)) (await warm(projectId)).assertStatus(202)
    const extra = projects[limit] ?? ''
    const refused = await warm(extra)
    refused.assertStatus(429)
    refused.assertBodyContains({ code: 'E_TOO_MANY_COMPILERS' })
    const compile = await client.post(`/api/v1/projects/${extra}/compile`).loginAs(user)
    compile.assertStatus(429)
    assert.lengthOf(worker.calledOn('/warm'), limit)
    assert.lengthOf(worker.calledOn('/compile'), 0)

    // Un projet déjà compté reste utilisable ; le plafond est propre à chaque utilisateur.
    ;(await warm(projects[0] ?? '')).assertStatus(202)
    ;(
      await client.post(`/api/v1/projects/${projects[1] ?? ''}/compile`).loginAs(user)
    ).assertStatus(202)
    ;(await warm(await newProject(client, other), other)).assertStatus(202)

    // Après la fenêtre (conteneurs endormis), de nouveaux projets sont acceptés.
    await db.rawQuery(
      `UPDATE compiler_activations SET last_activity_at = now() - interval '1 hour' WHERE user_id = ?`,
      [user.id],
    )
    ;(await warm(extra)).assertStatus(202)
  })

  test('checks membership on every route', async ({ client }) => {
    const owner = await createUser()
    const stranger = await createUser()
    const projectId = await newProject(client, owner)
    const queued = await client.post(`/api/v1/projects/${projectId}/compile`).loginAs(owner)
    const buildId = String(queued.body().buildId)
    const base = `/api/v1/projects/${projectId}`
    ;(await client.get(`${base}/builds/${buildId}`).loginAs(stranger)).assertStatus(404)
    ;(await client.post(`${base}/compiler/warm`).loginAs(stranger)).assertStatus(404)
    ;(await client.post(`${base}/compile/stop`).loginAs(stranger)).assertStatus(404)
    ;(await client.get(`${base}/builds/${buildId}`)).assertStatus(401)

    // Un lecteur peut suivre et compiler ; un build d'un autre projet reste introuvable.
    await ProjectMember.create({ projectId, userId: stranger.id, role: 'viewer' })
    ;(await client.get(`${base}/builds/${buildId}`).loginAs(stranger)).assertStatus(200)
    const other = await newProject(client, owner)
    ;(await client.get(`/api/v1/projects/${other}/builds/${buildId}`).loginAs(owner)).assertStatus(
      404,
    )
    ;(await client.get(`${base}/builds/not-a-uuid`).loginAs(owner)).assertStatus(404)
  })
})

test.group('compile (gateway mode)', (group) => {
  group.each.setup(() => testUtils.db().wrapInGlobalTransaction())

  test('has no warm-up and refuses worker callbacks', async ({ client }) => {
    const user = await createUser()
    const projectId = await newProject(client, user)
    const warm = await client.post(`/api/v1/projects/${projectId}/compiler/warm`).loginAs(user)
    warm.assertStatus(200)
    warm.assertBody({ status: 'unsupported' })
    const body = { projectId, buildId: randomUUID(), seq: 1, status: 'running' as const }
    ;(await callback(client, body)).assertStatus(404)
  })
})
