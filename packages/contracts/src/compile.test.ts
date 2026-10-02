import { describe, expect, it } from 'vitest'
import {
  agentCompileResponseSchema,
  type CompileRequest,
  compileOutputPrefix,
  compileRequestSchema,
  compileResultSchema,
  projectFilesPrefix,
} from './compile.js'

const projectId = '6f1c2d3e-4b5a-4c7d-8e9f-0a1b2c3d4e5f'
const buildId = '0b8f7e6d-5c4b-4a39-8281-7f6e5d4c3b2a'
const sha = 'a'.repeat(64)

function validRequest(): CompileRequest {
  return {
    projectId,
    buildId,
    compiler: 'pdflatex',
    rootResourcePath: 'main.tex',
    timeoutMs: 60_000,
    resources: [
      { path: 'main.tex', kind: 'text', content: '\\documentclass{article}', sha256: sha },
      {
        path: 'figures/plot.png',
        kind: 'binary',
        s3Key: `${projectFilesPrefix(projectId)}files/plot`,
        sha256: sha,
      },
    ],
    output: { bucket: 'kaxolax-compile-outputs', prefix: compileOutputPrefix(projectId, buildId) },
  }
}

function issuesOf(input: unknown): string[] {
  const result = compileRequestSchema.safeParse(input)
  return result.success ? [] : result.error.issues.map((issue) => issue.message)
}

describe('compileRequestSchema', () => {
  it('accepts the request from the specification', () => {
    expect(compileRequestSchema.parse(validRequest())).toEqual(validRequest())
  })

  it.each(['/etc/passwd', '../outside.tex', 'figures/../../x.png', 'a\\b.tex'])(
    'rejects the unsafe resource path %j',
    (path) => {
      const request = validRequest()
      request.resources.push({ path, kind: 'text', content: '', sha256: sha })
      expect(compileRequestSchema.safeParse(request).success).toBe(false)
    },
  )

  it('rejects duplicate paths', () => {
    const request = validRequest()
    request.resources.push({ path: 'main.tex', kind: 'text', content: '', sha256: sha })
    expect(issuesOf(request)).toContain('Duplicate or conflicting path: main.tex')
  })

  it('rejects a path used both as a file and as a folder', () => {
    const request = validRequest()
    request.resources.push({ path: 'figures', kind: 'text', content: '', sha256: sha })
    expect(issuesOf(request)).toContain('Duplicate or conflicting path: figures')

    const reversed = validRequest()
    reversed.resources.push({ path: 'main.tex/child.tex', kind: 'text', content: '', sha256: sha })
    expect(issuesOf(reversed)).toContain('Path is used both as a file and a folder: main.tex')
  })

  it('rejects a root that is missing or binary', () => {
    expect(issuesOf({ ...validRequest(), rootResourcePath: 'missing.tex' })).toContain(
      'Root resource must be one of the text resources',
    )
    expect(issuesOf({ ...validRequest(), rootResourcePath: 'figures/plot.png' })).toContain(
      'Root resource must be one of the text resources',
    )
  })

  it('rejects an output prefix outside outputs/{projectId}/{buildId}/', () => {
    const request = validRequest()
    request.output.prefix = `outputs/${projectId}/`
    expect(issuesOf(request)).toContain('Output prefix must be outputs/{projectId}/{buildId}/')
  })

  it('rejects a binary resource belonging to another project', () => {
    const request = validRequest()
    request.resources[1] = {
      path: 'figures/plot.png',
      kind: 'binary',
      s3Key: 'projects/00000000-0000-4000-8000-000000000000/files/plot',
      sha256: sha,
    }
    expect(issuesOf(request)).toContain('Binary resource must belong to the project')
  })

  it('rejects unknown compilers, bad hashes and out-of-range timeouts', () => {
    expect(compileRequestSchema.safeParse({ ...validRequest(), compiler: 'tex' }).success).toBe(
      false,
    )
    expect(compileRequestSchema.safeParse({ ...validRequest(), timeoutMs: 0 }).success).toBe(false)
    const request = validRequest()
    request.resources[0] = { path: 'main.tex', kind: 'text', content: '', sha256: 'ABC' }
    expect(compileRequestSchema.safeParse(request).success).toBe(false)
  })

  it('accepts compile options and refuses unknown ones', () => {
    const request = { ...validRequest(), options: { draft: true, haltOnFirstError: false } }
    expect(compileRequestSchema.parse(request).options).toEqual({
      draft: true,
      haltOnFirstError: false,
    })
    expect(
      compileRequestSchema.safeParse({ ...validRequest(), options: { shellEscape: true } }).success,
    ).toBe(false)
  })
})

describe('responses', () => {
  it('parses an agent response', () => {
    const response = {
      buildId,
      status: 'failure',
      durationMs: 1840,
      outputFiles: [
        {
          name: 'output.log',
          s3Key: `${compileOutputPrefix(projectId, buildId)}output.log`,
          sizeBytes: 12,
        },
      ],
      entries: [
        {
          level: 'error',
          file: 'chapters/intro.tex',
          line: 42,
          message: 'Undefined control sequence',
          raw: '...',
        },
      ],
      timings: { syncMs: 3, runMs: 1800, uploadMs: 37 },
    }
    expect(agentCompileResponseSchema.parse(response)).toEqual(response)
  })

  it('allows a null pdfUrl in the browser response', () => {
    expect(
      compileResultSchema.safeParse({
        buildId,
        status: 'failure',
        durationMs: 10,
        pdfUrl: null,
        logUrl: 'https://example.com/log',
        entries: [],
      }).success,
    ).toBe(true)
  })
})
