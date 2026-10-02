import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  type CompileRequest,
  compileOutputPrefix,
  INTERNAL_TOKEN_HEADER,
  projectFilesPrefix,
} from '@kaxolax/contracts'
import { pino } from 'pino'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Compiler } from '../../src/compiler.js'
import { buildContainerServer } from '../../src/container-server.js'
import { type CompileSandbox, type SandboxRunRequest } from '../../src/sandbox.js'
import { BinaryCache, LocalOutputStore } from '../../src/storage.js'

const token = 'c'.repeat(40)
const headers = { [INTERNAL_TOKEN_HEADER]: token }
const projectId = '6f1c2d3e-4b5a-4c7d-8e9f-0a1b2c3d4e5f'
const buildId = '0b8f7e6d-5c4b-4a39-8281-7f6e5d4c3b2a'
const bucket = 'kaxolax-compile-outputs'
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])
const sha256 = (data: string | Buffer) => createHash('sha256').update(data).digest('hex')

/** Faux sandbox : latexmk « écrit » ses sorties, synctex répond selon le fichier présent. */
class FakeSandbox implements CompileSandbox {
  runs: SandboxRunRequest[] = []

  workdirPath(hostWorkdir: string) {
    return hostWorkdir
  }

  async run(run: SandboxRunRequest) {
    this.runs.push(run)
    const cwd = run.workingDir ?? run.hostWorkdir
    let output = ''
    if (run.command[0] === 'latexmk') {
      await writeFile(join(cwd, 'output.pdf'), '%PDF-1.7 container')
      await writeFile(
        join(cwd, 'output.log'),
        'This is pdfTeX\nOutput written on output.pdf (1 page).\n',
      )
      await writeFile(join(cwd, 'output.synctex.gz'), 'synctex-data')
    } else {
      const data = await readFile(join(cwd, 'output.synctex.gz'), 'utf8')
      output = `SyncTeX result begin\nOutput:output.pdf\nPage:1\nh:1\nv:2\nW:3\nH:4\nfrom:${data}\nSyncTeX result end\n`
    }
    return {
      outcome: 'exited' as const,
      exitCode: 0,
      oomKilled: false,
      killReason: null,
      durationMs: 1,
      output,
    }
  }
}

let root: string
let sandbox: FakeSandbox

function setup() {
  const cache = new BinaryCache(join(root, 'cache'), (key) =>
    Promise.reject(new Error(`not pushed: ${key}`)),
  )
  const compiler = new Compiler({
    agentId: 'cf-test',
    compilesDir: join(root, 'compiles'),
    capacity: 1,
    workdirMaxBytes: 1024 * 1024,
    outputBucket: bucket,
    sandbox,
    binaries: cache,
    outputs: new LocalOutputStore(join(root, 'outputs')),
    logger: pino({ level: 'silent' }),
    uploadSynctex: true,
  })
  return buildContainerServer({
    compiler,
    cache,
    outputsDir: join(root, 'outputs'),
    outputBucket: bucket,
    internalToken: token,
    logger: pino({ level: 'silent' }),
  })
}

function compileRequest(): CompileRequest {
  const main = '\\documentclass{article}\\begin{document}x\\end{document}'
  return {
    projectId,
    buildId,
    compiler: 'pdflatex',
    rootResourcePath: 'main.tex',
    timeoutMs: 10_000,
    resources: [
      { path: 'main.tex', kind: 'text', content: main, sha256: sha256(main) },
      {
        path: 'plot.png',
        kind: 'binary',
        s3Key: `${projectFilesPrefix(projectId)}files/plot`,
        sha256: sha256(PNG),
      },
    ],
    output: { bucket, prefix: compileOutputPrefix(projectId, buildId) },
  }
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'kaxolax-container-'))
  sandbox = new FakeSandbox()
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('compile container server', () => {
  it('requires the internal token on the new routes too', async () => {
    const app = setup()
    const response = await app.inject({
      method: 'POST',
      url: '/blobs/missing',
      payload: { sha256: [] },
    })
    expect(response.statusCode).toBe(401)
  })

  it('takes pushed binaries, compiles, serves the outputs (SyncTeX included), then drops them', async () => {
    const app = setup()
    const missing = await app.inject({
      method: 'POST',
      url: '/blobs/missing',
      headers,
      payload: { sha256: [sha256(PNG), sha256(PNG)] },
    })
    expect(missing.json()).toEqual({ missing: [sha256(PNG)] })

    // Un contenu qui ne correspond pas à son sha256 est refusé.
    const corrupt = await app.inject({
      method: 'PUT',
      url: `/blobs/${sha256(PNG)}`,
      headers: { ...headers, 'content-type': 'application/octet-stream' },
      payload: Buffer.from('not the png'),
    })
    expect(corrupt.statusCode).toBe(400)
    const pushed = await app.inject({
      method: 'PUT',
      url: `/blobs/${sha256(PNG)}`,
      headers: { ...headers, 'content-type': 'application/octet-stream' },
      payload: PNG,
    })
    expect(pushed.statusCode).toBe(204)
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/blobs/missing',
          headers,
          payload: { sha256: [sha256(PNG)] },
        })
      ).json(),
    ).toEqual({ missing: [] })

    const compiled = await app.inject({
      method: 'POST',
      url: `/projects/${projectId}/compile`,
      headers,
      payload: compileRequest(),
    })
    expect(compiled.statusCode).toBe(200)
    const body = compiled.json<{ status: string; outputFiles: { name: string; s3Key: string }[] }>()
    expect(body.status).toBe('success')
    expect(body.outputFiles.map((file) => file.name)).toEqual([
      'output.pdf',
      'output.log',
      'output.synctex.gz',
    ])
    expect(sandbox.runs[0]?.command.slice(0, 2)).toEqual(['latexmk', '-norc'])
    expect(sandbox.runs[0]?.workingDir).toBe(join(root, 'compiles', projectId, 'files'))

    const pdf = await app.inject({
      method: 'GET',
      url: `/outputs/${body.outputFiles[0]?.s3Key ?? ''}`,
      headers,
    })
    expect(pdf.statusCode).toBe(200)
    expect(pdf.body).toBe('%PDF-1.7 container')
    // Hors des sorties d'une compilation : rien n'est lisible.
    for (const url of [
      `/outputs/outputs/${projectId}/${buildId}/main.tex`,
      `/outputs/outputs/${projectId}/${buildId}/../../../cache`,
      '/outputs/etc/passwd',
    ]) {
      expect((await app.inject({ method: 'GET', url, headers })).statusCode).toBe(404)
    }

    expect(
      (await app.inject({ method: 'DELETE', url: `/outputs/${projectId}/${buildId}`, headers }))
        .statusCode,
    ).toBe(204)
    expect(
      (
        await app.inject({
          method: 'GET',
          url: `/outputs/${body.outputFiles[0]?.s3Key ?? ''}`,
          headers,
        })
      ).statusCode,
    ).toBe(404)
  })

  it('restores the SyncTeX file of an earlier build into a fresh container', async () => {
    const app = setup()
    const available = () =>
      app.inject({ method: 'GET', url: `/projects/${projectId}/synctex/available`, headers })
    expect((await available()).json()).toEqual({ available: false })

    const bad = await app.inject({
      method: 'PUT',
      url: `/projects/${projectId}/synctex?root=../main.tex`,
      headers: { ...headers, 'content-type': 'application/gzip' },
      payload: Buffer.from('x'),
    })
    expect(bad.statusCode).toBe(400)

    const restored = await app.inject({
      method: 'PUT',
      url: `/projects/${projectId}/synctex?root=thesis/main.tex`,
      headers: { ...headers, 'content-type': 'application/gzip' },
      payload: Buffer.from('restored-synctex'),
    })
    expect(restored.statusCode).toBe(204)
    expect((await available()).json()).toEqual({ available: true })

    const view = await app.inject({
      method: 'GET',
      url: `/projects/${projectId}/synctex/code?file=thesis/main.tex&line=3`,
      headers,
    })
    expect(view.json()).toEqual({ pdf: [{ page: 1, h: 1, v: 2, width: 3, height: 4 }] })
    expect(sandbox.runs.at(-1)?.workingDir).toBe(
      join(root, 'compiles', projectId, 'files', 'thesis'),
    )
  })
})
