import { describe, expect, it } from 'vitest'
import { searchQueryFor } from './search-query'

/** Copie de `SearchQuery.unquote` de @codemirror/search 6.7.2 (recherche non littérale). */
function unquote(text: string): string {
  return text.replace(/\\([nrt\\])/g, (_, ch: string) =>
    ch === 'n' ? '\n' : ch === 'r' ? '\r' : ch === 't' ? '\t' : '\\',
  )
}

describe('searchQueryFor', () => {
  it('finds LaTeX commands that start like an escape sequence', () => {
    for (const text of [
      'La figure~\\ref{fig:courbe} montre',
      '\\newpage \\textbf{gras}',
      'ligne \\\\ suivante',
      '5~\\% près~\\cite{knuth}',
    ]) {
      expect(unquote(searchQueryFor(text))).toBe(text)
    }
  })

  it('leaves a text without backslash unchanged', () => {
    expect(searchQueryFor('Conductivités mesurées')).toBe('Conductivités mesurées')
  })
})
