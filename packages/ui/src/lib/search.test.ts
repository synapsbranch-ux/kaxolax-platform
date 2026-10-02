import { describe, expect, it } from 'vitest'
import { matchesSearch } from './search.js'

describe('matchesSearch', () => {
  it('ignores case, accents and word order', () => {
    expect(matchesSearch('equation', 'Équation numérotée')).toBe(true)
    expect(matchesSearch('intro sec', 'Section — Introduction')).toBe(true)
    expect(matchesSearch('figure', 'Tableau', ['table', 'tabular'])).toBe(false)
    expect(matchesSearch('tabu', 'Tableau', ['table', 'tabular'])).toBe(true)
    expect(matchesSearch('  ', 'Tout')).toBe(true)
  })
})
