import { createHash, randomUUID } from 'node:crypto'
import {
  type AgentCompileResponse,
  type CompileRequest,
  compileOutputPrefix,
  gatewayCompileResponseSchema,
  INTERNAL_TOKEN_HEADER,
} from '@kaxolax/contracts'
import Fastify, { type FastifyInstance } from 'fastify'
import { Redis } from 'ioredis'
import { pino } from 'pino'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { AgentPool } from '../src/agents.js'
import { affinityKey, CompileRouter } from '../src/router.js'
import { buildServer } from '../src/server.js'

const TOKEN = 'test-internal-token-0123456789abcdefghij'
const REDIS_URL = process.env.GATEWAY_TEST_REDIS_URL ?? 'redis://127.0.0.1:6379'

/** Faux agent : même API que l'agent réel, avec charge, lenteur et panne simulées. */
class FakeAgent {
  readonly app: FastifyInstance
  url = ''
  activeCompiles = 0
  compileDelayMs = 50
  compiles: string[] = []
  /** Options de compilation reçues, dans l'ordre des demandes. */
  options: CompileRequest['options'][] = []
  stops: string[] = []
  clears: string[] = []
  /** Compilations en cours par projet, et le maximum observé (tous agents confondus). */
  static running = new Map<string, number>()
  static maxConcurrent = new Map<string, number>()
  private readonly aborts = new Map<string, () => void>()
  private readonly finished = new Map<string, Promise<undefined>>()
  dropConnections = false

  constructor(readonly id: string) {
    this.app = Fastify()
    this.app.get('/health', () => ({
      agentId: this.id,
      activeCompiles: this.activeCompiles,
      capacity: 2,
    }))
    this.app.post<{ Params: { projectId: string }; Body: CompileRequest }>(
      '/projects/:projectId/compile',
      async (request, reply) => {
        if (this.dropConnections) {
          reply.raw.destroy()
          return reply
        }
        const { projectId, buildId } = request.body
        // Comme l'agent réel : une compilation du projet en cours est arrêtée et attendue.
        this.aborts.get(projectId)?.()
        await this.finished.get(projectId)
        this.compiles.push(buildId)
        this.options.push(request.body.options)
        const running = (FakeAgent.running.get(projectId) ?? 0) + 1
        FakeAgent.running.set(projectId, running)
        FakeAgent.maxConcurrent.set(
          projectId,
          Math.max(running, FakeAgent.maxConcurrent.get(projectId) ?? 0),
        )
        const state = { stopped: false }
        const finished = Promise.withResolvers<undefined>()
        this.finished.set(projectId, finished.promise)
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, this.compileDelayMs)
          this.aborts.set(projectId, () => {
            state.stopped = true
            clearTimeout(timer)
            resolve()
          })
        })
        this.aborts.delete(projectId)
        FakeAgent.running.set(projectId, (FakeAgent.running.get(projectId) ?? 1) - 1)
        finished.resolve(undefined)
        const response: AgentCompileResponse = {
          buildId,
          status: state.stopped ? 'error' : 'success',
          durationMs: 10,
          outputFiles: state.stopped
            ? []
            : [
                {
                  name: 'output.pdf',
                  s3Key: `${compileOutputPrefix(projectId, buildId)}output.pdf`,
                  sizeBytes: 100,
                },
              ],
          entries: [],
          timings: { syncMs: 1, runMs: 8, uploadMs: 1 },
        }
        return response
      },
    )
    this.app.post<{ Params: { projectId: string } }>('/projects/:projectId/stop', (request) => {
      this.stops.push(request.params.projectId)
      const abort = this.aborts.get(request.params.projectId)
      abort?.()
      return { stopped: abort !== undefined }
    })
    this.app.post<{ Params: { projectId: string } }>(
      '/projects/:projectId/clear-cache',
      (request) => {
        this.clears.push(request.params.projectId)
        return { cleared: true }
      },
    )
    this.app.get('/projects/:projectId/synctex/code', () => ({
      pdf: [{ page: 1, h: 72, v: 100, width: 300, height: 12, agent: this.id }],
    }))
    this.app.get('/projects/:projectId/synctex/pdf', () => ({
      code: [{ file: 'main.tex', line: 3, column: 0 }],
    }))
  }

  async start(): Promise<void> {
    this.url = await this.app.listen({ host: '127.0.0.1', port: 0 })
  }

  async stopServer(): Promise<void> {
    await this.app.close()
  }
}

const sha = (text: string) => createHash('sha256').update(text).digest('hex')

function compileRequest(projectId: string): CompileRequest {
  const buildId = randomUUID()
  const content = '\\documentclass{article}\\begin{document}x\\end{document}'
  return {
    projectId,
    buildId,
    compiler: 'pdflatex',
    rootResourcePath: 'main.tex',
    timeoutMs: 60_000,
    resources: [{ path: 'main.tex', kind: 'text', content, sha256: sha(content) }],
    output: { bucket: 'kaxolax-compile-outputs', prefix: compileOutputPrefix(projectId, buildId) },
  }
}

let redis: Redis
let agents: FakeAgent[]
let gateway: ReturnType<typeof buildServer>
const projects: string[] = []

function newProject(): string {
  const id = randomUUID()
  projects.push(id)
  return id
}

async function startGateway(list: FakeAgent[]) {
  const logger = pino({ level: 'silent' })
  const pool = new AgentPool(new Map(list.map((agent) => [agent.id, agent.url])), TOKEN, 300)
  const router = new CompileRouter(redis, pool, { affinityTtlSeconds: 60, logger })
  gateway = buildServer({ router, pool, internalToken: TOKEN, logger })
  await gateway.ready()
}

const post = (url: string, body?: unknown) =>
  gateway.inject({
    method: 'POST',
    url,
    headers: { [INTERNAL_TOKEN_HEADER]: TOKEN },
    ...(body === undefined ? {} : { payload: body as object }),
  })
const get = (url: string) =>
  gateway.inject({ method: 'GET', url, headers: { [INTERNAL_TOKEN_HEADER]: TOKEN } })

beforeAll(() => {
  redis = new Redis(REDIS_URL)
})

afterEach(async () => {
  await gateway.close()
  for (const agent of agents) await agent.stopServer().catch(() => undefined)
})

afterAll(async () => {
  if (projects.length > 0) {
    await redis.del(...projects.flatMap((id) => [affinityKey(id), `compile:lock:${id}`]))
  }
  await redis.quit()
})

async function setup(count: number) {
  agents = Array.from({ length: count }, (_, index) => new FakeAgent(`agent-${String(index + 1)}`))
  for (const agent of agents) await agent.start()
  await startGateway(agents)
  return agents
}

describe('routing', () => {
  it('compiles on the least loaded agent, then keeps the affinity', async () => {
    const [first, second] = await setup(2)
    if (!first || !second) throw new Error('agents')
    first.activeCompiles = 1
    const projectId = newProject()

    const response = await post('/compile', compileRequest(projectId))
    expect(response.statusCode).toBe(200)
    const body = gatewayCompileResponseSchema.parse(response.json())
    expect(body).toMatchObject({ agentId: 'agent-2', status: 'success' })
    expect(await redis.get(affinityKey(projectId))).toBe('agent-2')

    // L'affinité l'emporte sur la charge : le répertoire du projet est sur agent-2.
    first.activeCompiles = 0
    second.activeCompiles = 2
    const again = gatewayCompileResponseSchema.parse(
      (await post('/compile', compileRequest(projectId))).json(),
    )
    expect(again.agentId).toBe('agent-2')
    expect(second.compiles).toHaveLength(2)
  })

  it('forwards the compile options to the agent', async () => {
    const [agent] = await setup(1)
    if (!agent) throw new Error('agents')
    const projectId = newProject()
    const options = { draft: true, haltOnFirstError: true }
    const response = await post('/compile', { ...compileRequest(projectId), options })
    expect(response.statusCode).toBe(200)
    expect(agent.options).toEqual([options])

    const invalid = await post('/compile', {
      ...compileRequest(projectId),
      options: { shellEscape: true },
    })
    expect(invalid.statusCode).toBe(400)
  })

  it('moves to another agent when the assigned one is down', async () => {
    const [first, second] = await setup(2)
    if (!first || !second) throw new Error('agents')
    const projectId = newProject()
    await redis.set(affinityKey(projectId), 'agent-1')
    await first.stopServer()

    const body = gatewayCompileResponseSchema.parse(
      (await post('/compile', compileRequest(projectId))).json(),
    )
    expect(body.agentId).toBe('agent-2')
    expect(await redis.get(affinityKey(projectId))).toBe('agent-2')
  })

  it('retries on another agent when the compile connection is cut', async () => {
    const [first, second] = await setup(2)
    if (!first || !second) throw new Error('agents')
    const projectId = newProject()
    await redis.set(affinityKey(projectId), 'agent-1')
    first.dropConnections = true

    const body = gatewayCompileResponseSchema.parse(
      (await post('/compile', compileRequest(projectId))).json(),
    )
    expect(body.agentId).toBe('agent-2')
    expect(second.compiles).toHaveLength(1)
  })

  it('answers 503 when no agent is available', async () => {
    const [only] = await setup(1)
    await only?.stopServer()
    const response = await post('/compile', compileRequest(newProject()))
    expect(response.statusCode).toBe(503)
    expect(response.json()).toMatchObject({ error: 'no_agent_available' })
  })
})

describe('locks', () => {
  it('never runs two compiles of the same project at once: the newer one stops the older', async () => {
    const [first, second] = await setup(2)
    if (!first || !second) throw new Error('agents')
    for (const agent of agents) agent.compileDelayMs = 1_000
    const projectId = newProject()

    // Deux clics rapides sur « Recompiler », sans affinité préalable.
    const older = post('/compile', compileRequest(projectId))
    await new Promise((resolve) => setTimeout(resolve, 100))
    const newer = post('/compile', compileRequest(projectId))
    const [olderResponse, newerResponse] = await Promise.all([older, newer])

    expect(FakeAgent.maxConcurrent.get(projectId)).toBe(1)
    expect(gatewayCompileResponseSchema.parse(olderResponse.json()).status).toBe('error')
    expect(gatewayCompileResponseSchema.parse(newerResponse.json()).status).toBe('success')
    expect(first.stops.length + second.stops.length).toBe(1)
    // Le verrou est libéré une fois les deux demandes terminées.
    expect(await redis.get(`compile:lock:${projectId}`)).toBeNull()
  })

  it('sends simultaneous first compiles of a project to the same agent', async () => {
    await setup(3)
    const projectId = newProject()
    const responses = await Promise.all([
      post('/compile', compileRequest(projectId)),
      post('/compile', compileRequest(projectId)),
    ])
    const ids = responses.map(
      (response) => gatewayCompileResponseSchema.parse(response.json()).agentId,
    )
    expect(new Set(ids).size).toBe(1)
    expect(FakeAgent.maxConcurrent.get(projectId)).toBe(1)
  })
})

describe('other routes', () => {
  it('follows the affinity for stop and SyncTeX, and clears the cache on every agent', async () => {
    const [first, second] = await setup(2)
    if (!first || !second) throw new Error('agents')
    const projectId = newProject()
    expect((await get(`/projects/${projectId}/synctex/code?file=main.tex&line=3`)).statusCode).toBe(
      404,
    )
    await redis.set(affinityKey(projectId), 'agent-2')

    const synctex = await get(`/projects/${projectId}/synctex/code?file=main.tex&line=3&column=0`)
    expect(synctex.statusCode).toBe(200)
    expect(synctex.json()).toEqual({ pdf: [{ page: 1, h: 72, v: 100, width: 300, height: 12 }] })
    const reverse = await get(`/projects/${projectId}/synctex/pdf?page=1&h=72&v=100`)
    expect(reverse.json()).toEqual({ code: [{ file: 'main.tex', line: 3, column: 0 }] })
    expect((await get(`/projects/${projectId}/synctex/code?file=../x&line=1`)).statusCode).toBe(400)

    expect((await post(`/projects/${projectId}/stop`)).json()).toEqual({ stopped: false })
    expect(second.stops).toEqual([projectId])
    expect((await post(`/projects/${projectId}/clear-cache`)).json()).toEqual({ cleared: true })
    expect([first.clears, second.clears]).toEqual([[projectId], [projectId]])
  })

  it('reports agent health and refuses calls without the internal token', async () => {
    const [first] = await setup(2)
    await first?.stopServer()
    const health = await get('/health')
    expect(health.json()).toMatchObject({
      status: 'ok',
      agents: [
        { agentId: 'agent-1', available: false },
        { agentId: 'agent-2', available: true, capacity: 2 },
      ],
    })
    const anonymous = await gateway.inject({ method: 'POST', url: '/compile', payload: {} })
    expect(anonymous.statusCode).toBe(401)
    expect((await post('/compile', { projectId: 'nope' })).statusCode).toBe(400)
  })
})
