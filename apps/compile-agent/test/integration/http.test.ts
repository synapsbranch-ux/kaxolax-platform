import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3'
import { compileOutputPrefix, INTERNAL_TOKEN_HEADER, projectFilesPrefix } from '@kaxolax/contracts'
import { pino } from 'pino'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { type Agent, createAgent } from '../../src/agent.js'
import { type AgentConfig, loadConfig } from '../../src/config.js'
import { createS3Client } from '../../src/storage.js'
import { sha256Hex } from '../../src/workspace.js'
import { dockerAvailable, IMAGE, RUNTIME } from './helpers.js'

const token = 'integration-test-internal-token-000000'

async function s3Available(config: AgentConfig): Promise<boolean> {
  try {
    const response = await fetch(`${config.S3_ENDPOINT ?? ''}/healthz`)
    return response.ok
  } catch {
    if (process.env.KAXOLAX_REQUIRE_INTEGRATION === '1')
      throw new Error('S3 (docker compose) is not running')
    return false
  }
}

const root = await mkdtemp(join(tmpdir(), 'kaxolax-http-it-'))
const config = loadConfig({
  INTERNAL_TOKEN: token,
  COMPILE_IMAGE: IMAGE,
  COMPILE_RUNTIME: RUNTIME,
  COMPILES_DIR: join(root, 'compiles'),
  CACHE_DIR: join(root, 'cache'),
  S3_ENDPOINT: process.env.S3_ENDPOINT ?? 'http://localhost:8333',
  S3_FORCE_PATH_STYLE: 'true',
  S3_ACCESS_KEY_ID: process.env.S3_ACCESS_KEY_ID ?? 'kaxolax',
  S3_SECRET_ACCESS_KEY: process.env.S3_SECRET_ACCESS_KEY ?? 'kaxolax-local-secret',
  S3_BUCKET_PROJECT_FILES: 'kaxolax-project-files',
  S3_BUCKET_COMPILE_OUTPUTS: 'kaxolax-compile-outputs',
})
const available = (await dockerAvailable()) && (await s3Available(config))

describe.skipIf(!available)('agent over HTTP with S3', () => {
  let agent: Agent
  const s3 = createS3Client(config)
  const headers = { [INTERNAL_TOKEN_HEADER]: token }

  beforeAll(async () => {
    agent = await createAgent(config, { logger: pino({ level: 'silent' }) })
  })

  afterAll(async () => {
    await agent.close()
    s3.destroy()
    await rm(root, { recursive: true, force: true })
  })

  async function uploadFigure(projectId: string) {
    const bytes = await readFile(join(import.meta.dirname, '../../examples/demo/figures/plot.png'))
    const s3Key = `${projectFilesPrefix(projectId)}files/${randomUUID()}`
    await s3.send(
      new PutObjectCommand({ Bucket: config.S3_BUCKET_PROJECT_FILES, Key: s3Key, Body: bytes }),
    )
    return { s3Key, sha256: sha256Hex(bytes) }
  }

  function body(projectId: string, figure: { s3Key: string; sha256: string }) {
    const buildId = randomUUID()
    const main =
      '\\documentclass{article}\\usepackage{graphicx}\\begin{document}\\includegraphics{plot.png}\\end{document}'
    return {
      projectId,
      buildId,
      compiler: 'pdflatex',
      rootResourcePath: 'main.tex',
      timeoutMs: 60_000,
      resources: [
        { path: 'main.tex', kind: 'text', content: main, sha256: sha256Hex(main) },
        { path: 'plot.png', kind: 'binary', ...figure },
      ],
      output: {
        bucket: config.S3_BUCKET_COMPILE_OUTPUTS,
        prefix: compileOutputPrefix(projectId, buildId),
      },
    }
  }

  it('downloads binaries from S3 and uploads the outputs', async () => {
    const projectId = randomUUID()
    const figure = await uploadFigure(projectId)
    const response = await agent.server.inject({
      method: 'POST',
      url: `/projects/${projectId}/compile`,
      headers,
      payload: body(projectId, figure),
    })
    expect(response.statusCode).toBe(200)
    const result = response.json<{
      status: string
      outputFiles: { name: string; s3Key: string }[]
    }>()
    expect(result.status).toBe('success')
    const pdf = result.outputFiles.find((file) => file.name === 'output.pdf')
    const object = await s3.send(
      new GetObjectCommand({ Bucket: config.S3_BUCKET_COMPILE_OUTPUTS, Key: pdf?.s3Key ?? '' }),
    )
    const bytes = Buffer.from((await object.Body?.transformToByteArray()) ?? [])
    expect(bytes.subarray(0, 5).toString()).toBe('%PDF-')
    expect(object.ContentType).toBe('application/pdf')
  })

  it('refuses a binary whose content does not match its sha256', async () => {
    const projectId = randomUUID()
    const figure = await uploadFigure(projectId)
    const response = await agent.server.inject({
      method: 'POST',
      url: `/projects/${projectId}/compile`,
      headers,
      payload: body(projectId, { ...figure, sha256: 'f'.repeat(64) }),
    })
    const result = response.json<{ status: string; entries: { message: string }[] }>()
    expect(result.status).toBe('error')
    expect(result.entries[0]?.message).toContain('sha256 mismatch')
  })

  it('refuses an output bucket other than its own', async () => {
    const projectId = randomUUID()
    const figure = await uploadFigure(projectId)
    const payload = body(projectId, figure)
    payload.output.bucket = 'someone-else-bucket'
    const response = await agent.server.inject({
      method: 'POST',
      url: `/projects/${projectId}/compile`,
      headers,
      payload,
    })
    expect(response.statusCode).toBe(400)
  })
})
