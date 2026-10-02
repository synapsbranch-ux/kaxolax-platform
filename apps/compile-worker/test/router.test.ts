import {
  compileRequestKey,
  signCompileWorkerToken,
  type WorkerCompileJob,
} from '@kaxolax/contracts'
import { describe, expect, it } from 'vitest'
import { handleRequest, type ProjectCompiler } from '../src/router.js'
import { buildId, job, projectId } from './fakes.js'

const secret = 'test-compile-worker-secret-0123456789abcdef'
const otherProject = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d'

function stub(overrides: Partial<ProjectCompiler> = {}) {
  const calls: unknown[][] = []
  const compiler: ProjectCompiler = {
    enqueue: (received: WorkerCompileJob) => {
      calls.push(['enqueue', received])
      return Promise.resolve({ buildId: received.buildId, status: 'preparing' as const })
    },
    cancel: (id) => {
      calls.push(['cancel', id])
      return Promise.resolve()
    },
    warm: () => {
      calls.push(['warm'])
      return Promise.resolve()
    },
    clearCache: () => Promise.resolve(true),
    synctex: (kind, query, id) => {
      calls.push(['synctex', kind, query, id])
      return Promise.resolve({ pdf: [] })
    },
    ...overrides,
  }
  return { compiler, calls }
}

async function call(
  path: string,
  init: RequestInit & { project?: string; token?: string | null } = {},
  compiler = stub().compiler,
) {
  const token =
    init.token === undefined
      ? await signCompileWorkerToken(init.project ?? projectId, secret)
      : init.token
  const headers = new Headers(init.headers)
  if (token !== null) headers.set('authorization', `Bearer ${token}`)
  return handleRequest(new Request(`https://compile.example${path}`, { ...init, headers }), {
    secret,
    compilerFor: () => compiler,
  })
}

const post = (body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
})

describe('worker router', () => {
  it('answers health without a token, and 404/405 on unknown routes', async () => {
    expect((await call('/health', { token: null })).status).toBe(200)
    expect((await call(`/projects/${projectId}/unknown`)).status).toBe(404)
    expect((await call(`/projects/${projectId}/compile`, { method: 'GET' })).status).toBe(405)
  })

  it('requires a valid token for the project of the URL', async () => {
    const base = `/projects/${projectId}/warm`
    expect((await call(base, { method: 'POST', token: null })).status).toBe(401)
    expect((await call(base, { method: 'POST', token: 'v1.abc.def' })).status).toBe(401)
    expect((await call(base, { method: 'POST', project: otherProject })).status).toBe(401)
    const forged = await signCompileWorkerToken(projectId, `${secret}-other`)
    expect((await call(base, { method: 'POST', token: forged })).status).toBe(401)
  })

  it('queues a compile job for the project and checks its request key', async () => {
    const { compiler, calls } = stub()
    const accepted = await call(`/projects/${projectId}/compile`, post(job()), compiler)
    expect(accepted.status).toBe(202)
    expect(await accepted.json()).toEqual({ buildId, status: 'preparing' })
    expect(calls).toEqual([['enqueue', job()]])

    const elsewhere = { ...job(), requestKey: compileRequestKey(otherProject, buildId) }
    expect((await call(`/projects/${projectId}/compile`, post(elsewhere), compiler)).status).toBe(
      400,
    )
    const foreign = { ...job(), projectId: otherProject }
    expect((await call(`/projects/${projectId}/compile`, post(foreign), compiler)).status).toBe(400)
    expect(
      (await call(`/projects/${projectId}/compile`, { ...post(null), body: '{' }, compiler)).status,
    ).toBe(400)
  })

  it('relays cancel, warm, clear-cache and SyncTeX', async () => {
    const { compiler, calls } = stub()
    expect((await call(`/projects/${projectId}/cancel`, post({ buildId }), compiler)).status).toBe(
      202,
    )
    expect((await call(`/projects/${projectId}/warm`, { method: 'POST' }, compiler)).status).toBe(
      202,
    )
    const cleared = await call(`/projects/${projectId}/clear-cache`, { method: 'POST' }, compiler)
    expect(await cleared.json()).toEqual({ cleared: true })
    const synctex = await call(
      `/projects/${projectId}/synctex/code?file=main.tex&line=3&buildId=${buildId}`,
      {},
      compiler,
    )
    expect(synctex.status).toBe(200)
    expect(calls).toEqual([
      ['cancel', buildId],
      ['warm'],
      ['synctex', 'code', { file: 'main.tex', line: '3', column: '0' }, buildId],
    ])
    expect(
      (
        await call(
          `/projects/${projectId}/synctex/pdf?page=0&h=1&v=1&buildId=${buildId}`,
          {},
          compiler,
        )
      ).status,
    ).toBe(400)
  })

  it('maps a missing SyncTeX output to 404 and a failing project object to 503', async () => {
    const empty = stub({ synctex: () => Promise.resolve(null) }).compiler
    const missing = await call(
      `/projects/${projectId}/synctex/pdf?page=1&h=1&v=2&buildId=${buildId}`,
      {},
      empty,
    )
    expect(missing.status).toBe(404)
    const broken = stub({ warm: () => Promise.reject(new Error('boom')) }).compiler
    expect((await call(`/projects/${projectId}/warm`, { method: 'POST' }, broken)).status).toBe(503)
  })
})
