import { describe, expect, it } from 'vitest'
import { synctexCodeQuerySchema, synctexPdfQuerySchema } from './synctex.js'

describe('synctex queries', () => {
  it('coerces query-string values', () => {
    expect(
      synctexCodeQuerySchema.parse({ file: 'chapters/intro.tex', line: '42', column: '3' }),
    ).toEqual({ file: 'chapters/intro.tex', line: 42, column: 3 })
    expect(synctexPdfQuerySchema.parse({ page: '2', h: '72.5', v: '100' })).toEqual({
      page: 2,
      h: 72.5,
      v: 100,
    })
  })

  it('defaults the column to 0', () => {
    expect(synctexCodeQuerySchema.parse({ file: 'main.tex', line: '1' }).column).toBe(0)
  })

  it('rejects unsafe files and invalid numbers', () => {
    expect(synctexCodeQuerySchema.safeParse({ file: '../main.tex', line: '1' }).success).toBe(false)
    expect(synctexCodeQuerySchema.safeParse({ file: 'main.tex', line: '0' }).success).toBe(false)
    expect(synctexPdfQuerySchema.safeParse({ page: '1', h: 'NaN', v: '1' }).success).toBe(false)
  })
})
