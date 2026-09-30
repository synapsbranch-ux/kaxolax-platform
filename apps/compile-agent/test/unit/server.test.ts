import { compileOutputPrefix, INTERNAL_TOKEN_HEADER } from '@kaxolax/contracts'
import { pino } from 'pino'
import { describe, expect, it } from 'vitest'
import { type Compiler, InvalidRequestError } from '../../src/compiler.js'
import { buildServer } from '../../src/server.js'

const token = 'x'.repeat(40)
const projectId = '6f1c2d3e-4b5a-4c7d-8e9f-0a1b2c3d4e5f'
const buildId = '0b8f7e6d-5c4b-4a39-8281-7f6e5d4c3b2a'

function fakeCompiler(overrides: Partial<Compiler> = {}): Compiler {
  return {
    health: () => ({ agentId: 'a1', activeCompiles: 0, capacity: 2 }),
    compile: () =>
      Promise.resolve({
        buildId,
        status: 'success',
        durationMs: 5,
        outputFiles: [],
        entries: [],
        timings: { syncMs: 1, runMs: 3, uploadMs: 1 },
      }),
    stop: () => Promise.resolve(true),
    clearCache: () => Promise.resolve(true),
    synctexFromCode: () => Promise.resolve({ pdf: [] }),
    synctexFromPdf: () => Promise.resolve({ code: [] }),
    ...overrides,
  } as unknown as Compiler
}

function request() {
  return {
    projectId,
    buildId,
    compiler: 'pdflatex',
    rootResourcePath: 'main.tex',
    timeoutMs: 60_000,
    resources: [{ path: 'main.tex', kind: 'text', content: 'x', sha256: 'a'.repeat(64) }],
    output: { bucket: 'kaxolax-compile-outputs', prefix: compileOutputPrefix(projectId, buildId) },
  }
}

const headers = { [INTERNAL_TOKEN_HEADER]: token }
const logger = pino({ level: 'silent' })

describe('agent HTTP server', () => {
  it('rejects requests without the internal token', async () => {
    const app = buildServer({ compiler: fakeCompiler(), internalToken: token, logger })
    expect((await app.inject({ method: 'GET', url: '/health' })).statusCode).toBe(401)
    const wrong = await app.inject({
      method: 'GET',
      url: '/health',
      headers: { [INTERNAL_TOKEN_HEADER]: 'nope' },
    })
    expect(wrong.statusCode).toBe(401)
  })

  it('reports health', async () => {
    const app = buildServer({ compiler: fakeCompiler(), internalToken: token, logger })
    const response = await app.inject({ method: 'GET', url: '/health', headers })
    expect(response.json()).toEqual({ agentId: 'a1', activeCompiles: 0, capacity: 2 })
  })

  it('validates the compile request against the shared contract', async () => {
    const app = buildServer({ compiler: fakeCompiler(), internalToken: token, logger })
    const ok = await app.inject({
      method: 'POST',
      url: `/projects/${projectId}/compile`,
      headers,
      payload: request(),
    })
    expect(ok.statusCode).toBe(200)
    expect(ok.json()).toMatchObject({ status: 'success', buildId })

    const unsafe = request()
    unsafe.resources[0] = {
      path: '../escape.tex',
      kind: 'text',
      content: 'x',
      sha256: 'a'.repeat(64),
    }
    const bad = await app.inject({
      method: 'POST',
      url: `/projects/${projectId}/compile`,
      headers,
      payload: unsafe,
    })
    expect(bad.statusCode).toBe(400)

    const other = await app.inject({
      method: 'POST',
      url: '/projects/00000000-0000-4000-8000-000000000000/compile',
      headers,
      payload: request(),
    })
    expect(other.statusCode).toBe(400)
  })

  it('maps compiler validation errors to 400', async () => {
    const compiler = fakeCompiler({
      compile: () => Promise.reject(new InvalidRequestError('Unexpected output bucket')),
    })
    const app = buildServer({ compiler, internalToken: token, logger })
    const response = await app.inject({
      method: 'POST',
      url: `/projects/${projectId}/compile`,
      headers,
      payload: request(),
    })
    expect(response.statusCode).toBe(400)
  })

  it('exposes stop, clear-cache and synctex routes', async () => {
    const app = buildServer({ compiler: fakeCompiler(), internalToken: token, logger })
    expect(
      (await app.inject({ method: 'POST', url: `/projects/${projectId}/stop`, headers })).json(),
    ).toEqual({ stopped: true })
    expect(
      (
        await app.inject({ method: 'POST', url: `/projects/${projectId}/clear-cache`, headers })
      ).json(),
    ).toEqual({ cleared: true })
    const code = await app.inject({
      method: 'GET',
      url: `/projects/${projectId}/synctex/code?file=main.tex&line=3`,
      headers,
    })
    expect(code.json()).toEqual({ pdf: [] })
    const pdf = await app.inject({
      method: 'GET',
      url: `/projects/${projectId}/synctex/pdf?page=1&h=10&v=20`,
      headers,
    })
    expect(pdf.json()).toEqual({ code: [] })
    const invalid = await app.inject({
      method: 'GET',
      url: `/projects/${projectId}/synctex/code?file=../x&line=3`,
      headers,
    })
    expect(invalid.statusCode).toBe(400)
  })
})
