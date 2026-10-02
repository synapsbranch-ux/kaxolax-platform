import { describe, expect, it } from 'vitest'
import { MAX_SEARCH_QUERY_LENGTH, projectSearchQuerySchema } from './search.js'

describe('projectSearchQuerySchema', () => {
  it('reads boolean flags from the query string', () => {
    expect(projectSearchQuerySchema.parse({ q: 'x', caseSensitive: 'true', regex: '1' })).toEqual({
      q: 'x',
      caseSensitive: true,
      wholeWord: false,
      regex: true,
    })
  })

  it.each([
    {},
    { q: '' },
    { q: 'x'.repeat(MAX_SEARCH_QUERY_LENGTH + 1) },
    { q: 'x', regex: 'yes' },
  ])('rejects %j', (query) => {
    expect(projectSearchQuerySchema.safeParse(query).success).toBe(false)
  })
})
