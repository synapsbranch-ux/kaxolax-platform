import { describe, expect, it } from 'vitest'
import { bibtexToText, parseBibtex, shortAuthors } from './bibtex.js'

describe('parseBibtex', () => {
  it('parses entries with braces, quotes, numbers, macros and concatenation', () => {
    const bib = `
Texte libre ignoré, même avec une adresse a@b.fr.
@string{ jcp = "Journal of Computational Physics" }
@String(pre = {Pr})

@Article{knuth1984,
  author  = {Donald E. Knuth},
  title   = {Literate {P}rogramming},
  journal = jcp,
  year    = 1984,
  month   = jan,
  note    = pre # "oceedings " # {vol. 2},
}

@book(lamport94, title = "{\\LaTeX}: A Document {"}Preparation{"} System", year = "1994")
@misc{empty-fields}
@online{web:2020/x+y.z,
  url = {https://example.org/a%20b},
  date = {2020-05-01}
}`
    const { entries, errors, strings } = parseBibtex(bib)
    expect(errors).toEqual([])
    expect(entries.map((entry) => [entry.type, entry.key])).toEqual([
      ['article', 'knuth1984'],
      ['book', 'lamport94'],
      ['misc', 'empty-fields'],
      ['online', 'web:2020/x+y.z'],
    ])
    const [knuth, lamport, , online] = entries
    expect(knuth?.fields).toMatchObject({
      author: 'Donald E. Knuth',
      title: 'Literate {P}rogramming',
      journal: 'Journal of Computational Physics',
      year: '1984',
      month: 'January',
      note: 'Proceedings vol. 2',
    })
    expect(knuth?.line).toBe(6)
    expect(lamport?.fields.title).toBe('{\\LaTeX}: A Document {"}Preparation{"} System')
    // Un `%` dans une valeur entre accolades n'est pas un commentaire.
    expect(online?.fields.url).toBe('https://example.org/a%20b')
    expect(strings.jcp).toBe('Journal of Computational Physics')
  })

  it('skips @comment and @preamble, and % comments between fields', () => {
    const { entries, errors } = parseBibtex(`@comment{ @article{fake, title={x}} }
@preamble{ "\\newcommand{\\noop}[1]{}" }
% @article{commented, title={no}}
@article{real,
  % title = {ignored},
  title = {Kept},
}`)
    expect(errors).toEqual([])
    expect(entries.map((entry) => entry.key)).toEqual(['real'])
    expect(entries[0]?.fields.title).toBe('Kept')
  })

  it('recovers after a malformed entry and reports errors with their line', () => {
    const { entries, errors } = parseBibtex(`@article{broken,
  title = {Unclosed,
  year = 2000

@book{ok1, title = {Fine}}
@article{nokey title = {x}}
@book{ok2, title = {Also fine}, author = "A and B"}
@book{ok1, title = {Duplicate}}`)
    expect(entries.map((entry) => entry.key)).toEqual(['ok1', 'ok2'])
    expect(entries[0]?.fields.title).toBe('Fine')
    expect(errors.map((error) => [error.line, error.message])).toEqual([
      [2, 'Unclosed brace'],
      [6, 'Expected ","'],
      [8, 'Duplicate key "ok1"'],
    ])
  })

  it('handles a large file quickly', () => {
    const bib = Array.from(
      { length: 5000 },
      (_, i) =>
        `@article{key${String(i)},\n  author = {Author ${String(i)} and Other, Some},\n  title = {Title {${String(i)}}},\n  year = {2020}\n}\n`,
    ).join('\n')
    const start = performance.now()
    const { entries } = parseBibtex(bib)
    expect(entries).toHaveLength(5000)
    expect(performance.now() - start).toBeLessThan(500)
  })
})

describe('display helpers', () => {
  it('converts LaTeX accents and markup to readable text', () => {
    expect(bibtexToText("Th{\\'e}orie des {\\'E}quations \\& {G}\\\"odel~\\emph{et al.}")).toBe(
      'Théorie des Équations & Gödel et al.',
    )
    expect(bibtexToText('Fran\\c{c}ois \\oe uvre -- {X}')).toBe('François œuvre – X')
  })

  it('abbreviates author lists', () => {
    expect(shortAuthors('Knuth, Donald E.')).toBe('Knuth')
    expect(shortAuthors('Donald Knuth and Leslie Lamport')).toBe('Knuth & Lamport')
    expect(shortAuthors('A. One and B. Two and C. Three')).toBe('One et al.')
    expect(shortAuthors('A. One and others')).toBe('One')
  })
})
