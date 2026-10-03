import { describe, expect, it } from 'vitest'
import {
  type ConvertRequest,
  convertFailureSchema,
  convertRequestSchema,
  convertResultSchema,
  MAX_CONVERT_TIMEOUT_MS,
  MAX_MARKDOWN_BYTES,
} from './convert.js'

const projectId = '6f1c2d3e-4b5a-4c7d-8e9f-0a1b2c3d4e5f'

function request(overrides: Partial<ConvertRequest> = {}): ConvertRequest {
  return {
    projectId,
    sourcePath: 'notes/intro.md',
    targetPath: 'chapters/intro.tex',
    markdown: '# Bonjour',
    ...overrides,
  }
}

describe('convertRequestSchema', () => {
  it('accepts a minimal and a complete request', () => {
    expect(convertRequestSchema.safeParse(request()).success).toBe(true)
    expect(
      convertRequestSchema.safeParse(
        request({
          graphicsDir: '',
          mediaDir: 'chapters/media',
          media: ['figures/plot.png'],
          options: {
            mode: 'fragment',
            documentClass: 'scrreprt',
            topLevelDivision: 'chapter',
            numberSections: true,
            citations: 'biblatex',
            rawLatex: true,
          },
          timeoutMs: MAX_CONVERT_TIMEOUT_MS,
        }),
      ).success,
    ).toBe(true)
  })

  it('accepts a .tex target whatever its case, like the import body', () => {
    expect(convertRequestSchema.safeParse(request({ targetPath: 'Notes.TEX' })).success).toBe(true)
  })

  it('refuses unsafe paths, a target that is not a .tex file and unknown options', () => {
    for (const invalid of [
      request({ sourcePath: '../notes.md' }),
      request({ targetPath: '/tmp/out.tex' }),
      request({ targetPath: 'notes.md' }),
      request({ graphicsDir: '..' }),
      request({ mediaDir: 'media/../..' }),
      request({ media: ['/etc/passwd'] }),
      { ...request(), options: { luaFilter: 'evil.lua' } },
      { ...request(), options: { documentClass: 'article}\\input{/etc/passwd' } },
      request({ timeoutMs: MAX_CONVERT_TIMEOUT_MS + 1 }),
    ]) {
      expect(convertRequestSchema.safeParse(invalid).success).toBe(false)
    }
  })

  it('limits the Markdown size in UTF-8 bytes', () => {
    const accents = 'é'.repeat(MAX_MARKDOWN_BYTES / 2)
    expect(convertRequestSchema.safeParse(request({ markdown: accents })).success).toBe(true)
    expect(convertRequestSchema.safeParse(request({ markdown: `${accents}x` })).success).toBe(false)
  })
})

describe('convert result and failure', () => {
  it('describes the LaTeX, the extracted media and each image', () => {
    const parsed = convertResultSchema.safeParse({
      latex: '\\section{Bonjour}\n',
      preamble: '\\usepackage{graphicx}\n',
      title: 'Bonjour',
      media: [
        {
          path: 'chapters/media/abc.png',
          contentType: 'image/png',
          sizeBytes: 3,
          sha256: 'a'.repeat(64),
          contentBase64: 'AAAA',
        },
      ],
      images: [
        { source: 'plot.png', kind: 'project', path: 'notes/plot.png', reason: null, found: true },
        {
          source: '/etc/passwd',
          kind: 'rejected',
          path: null,
          reason: 'absolute_path',
          found: null,
        },
      ],
      warnings: [],
      durationMs: 120,
    })
    expect(parsed.success).toBe(true)
    expect(
      convertResultSchema.safeParse({
        ...parsed.data,
        media: [{ ...parsed.data?.media[0], path: '../escape.png' }],
      }).success,
    ).toBe(false)
  })

  it('names the failure reasons', () => {
    expect(
      convertFailureSchema.parse({
        error: 'convert_failed',
        reason: 'out_of_memory',
        message: 'Conversion ran out of memory',
      }).reason,
    ).toBe('out_of_memory')
    expect(
      convertFailureSchema.safeParse({ error: 'convert_failed', reason: 'other', message: '' })
        .success,
    ).toBe(false)
  })
})
