import { describe, expect, it } from 'vitest'
import { logEntrySchema } from './log.js'
import {
  MAX_WORD_COUNT_TEXT_BYTES,
  wordCountBodySchema,
  type WordCountRequest,
  wordCountRequestSchema,
  wordCountResultSchema,
} from './word-count.js'

const projectId = '6f1c2d3e-4b5a-4c7d-8e9f-0a1b2c3d4e5f'
const sha = 'a'.repeat(64)

function request(overrides: Partial<WordCountRequest> = {}): WordCountRequest {
  return {
    projectId,
    rootResourcePath: 'main.tex',
    resources: [
      { path: 'main.tex', kind: 'text', content: '\\input{chapters/intro}', sha256: sha },
      { path: 'chapters/intro.tex', kind: 'text', content: 'Bonjour.', sha256: sha },
    ],
    ...overrides,
  }
}

describe('wordCountRequestSchema', () => {
  it('accepte une demande valide', () => {
    expect(wordCountRequestSchema.safeParse(request()).success).toBe(true)
  })

  it('exige que le document principal fasse partie des ressources', () => {
    expect(wordCountRequestSchema.safeParse(request({ rootResourcePath: 'x.tex' })).success).toBe(
      false,
    )
  })

  it('refuse les chemins dangereux, en double, et les ressources binaires', () => {
    const [main] = request().resources
    if (!main) throw new Error('fixture')
    expect(
      wordCountRequestSchema.safeParse(
        request({ resources: [main, { ...main, path: '../etc/passwd' }] }),
      ).success,
    ).toBe(false)
    expect(wordCountRequestSchema.safeParse(request({ resources: [main, main] })).success).toBe(
      false,
    )
    expect(
      wordCountRequestSchema.safeParse({
        ...request(),
        resources: [main, { path: 'a.png', kind: 'binary', s3Key: 'x', sha256: sha }],
      }).success,
    ).toBe(false)
  })

  it('plafonne la taille cumulée du texte', () => {
    const big = 'a'.repeat(MAX_WORD_COUNT_TEXT_BYTES)
    expect(
      wordCountRequestSchema.safeParse(
        request({
          resources: [
            { path: 'main.tex', kind: 'text', content: big, sha256: sha },
            { path: 'b.tex', kind: 'text', content: 'b', sha256: sha },
          ],
        }),
      ).success,
    ).toBe(false)
  })
})

describe('wordCountResultSchema', () => {
  it('valide un résultat analysé', () => {
    const counts = {
      words: 3,
      text: 2,
      headers: 1,
      captions: 0,
      headerCount: 1,
      floatCount: 0,
      inlineMathCount: 0,
      displayMathCount: 0,
    }
    expect(
      wordCountResultSchema.safeParse({
        total: counts,
        sections: [{ ...counts, kind: 'section', title: 'Introduction' }],
        warnings: [],
      }).success,
    ).toBe(true)
  })

  it('n’accepte que documentId dans le corps de la route', () => {
    expect(wordCountBodySchema.safeParse({}).success).toBe(true)
    expect(wordCountBodySchema.safeParse({ documentId: projectId }).success).toBe(true)
    expect(wordCountBodySchema.safeParse({ other: 1 }).success).toBe(false)
  })
})

describe('logEntrySchema.missingFile', () => {
  it('est facultatif et conservé', () => {
    const entry = { level: 'error', file: 'main.tex', line: 2, message: 'x', raw: '' } as const
    expect(logEntrySchema.parse(entry)).toEqual(entry)
    expect(logEntrySchema.parse({ ...entry, missingFile: 'amsmth.sty' }).missingFile).toBe(
      'amsmth.sty',
    )
  })
})
