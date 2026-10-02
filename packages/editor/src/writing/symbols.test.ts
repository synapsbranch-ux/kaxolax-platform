import { describe, expect, it } from 'vitest'
import { symbolMissingPackages, symbolSnippet } from './apply.js'
import { FORMULA_CATEGORIES, FORMULA_LIBRARY } from './formula-library.js'
import { mathPackages, missingPackages } from './math-packages.js'
import {
  foldText,
  parseRecentSymbols,
  pushRecentSymbol,
  recentSymbols,
  RECENT_SYMBOLS_LIMIT,
  searchSymbols,
  serializeRecentSymbols,
  SYMBOL_CATEGORIES,
  symbolById,
  SYMBOLS,
} from './symbols.js'

/** Symbole du catalogue (le test échoue s'il manque). */
function symbol(id: string) {
  const found = symbolById(id)
  if (!found) throw new Error(`missing symbol ${id}`)
  return found
}

describe('symbol catalogue', () => {
  it('has unique ids and complete entries in every category', () => {
    expect(new Set(SYMBOLS.map((item) => item.id)).size).toBe(SYMBOLS.length)
    for (const category of SYMBOL_CATEGORIES) {
      expect(SYMBOLS.filter((item) => item.category === category.id).length).toBeGreaterThan(5)
    }
    for (const item of SYMBOLS) {
      expect(item.command).toMatch(/^\\/)
      expect(item.glyph).not.toBe('')
      expect(item.name.fr).not.toBe('')
      expect(item.name.en).not.toBe('')
      for (const name of item.packages) expect(name).toMatch(/^[a-z]+$/)
    }
  })

  it('knows the package of each symbol', () => {
    expect(symbol('\\alpha').packages).toEqual([])
    expect(symbol('\\leqslant').packages).toEqual(['amssymb'])
    expect(symbol('\\mathbb{R}').packages).toEqual(['amssymb'])
    expect(symbol('\\iint').packages).toEqual(['amsmath'])
    expect(symbol('\\llbracket').packages).toEqual(['stmaryrd'])
    expect(symbol('\\coloneqq').packages).toEqual(['mathtools'])
    expect(symbol('\\texteuro').mode).toBe('text')
    expect(symbol('\\hat').argument).toBe(true)
  })
})

describe('searchSymbols', () => {
  it('ignores case and accents', () => {
    expect(searchSymbols('thêta')[0]?.id).toBe('\\theta')
    expect(searchSymbols('THETA')[0]?.id).toBe('\\theta')
    expect(searchSymbols('omega').map((item) => item.id)).toContain('\\Omega')
    expect(searchSymbols('fleche').filter((item) => item.category !== 'arrows')).toHaveLength(1)
    expect(searchSymbols('flèche droite')[0]?.id).toBe('\\rightarrow')
    expect(foldText('  Élément ')).toBe('element')
  })

  it('ranks exact commands first, with or without backslash', () => {
    expect(searchSymbols('in')[0]?.id).toBe('\\in')
    expect(searchSymbols('\\leq')[0]?.id).toBe('\\leq')
    expect(searchSymbols('infini')[0]?.id).toBe('\\infty')
    expect(searchSymbols('appartient')[0]?.id).toBe('\\in')
    expect(searchSymbols('real numbers')[0]?.id).toBe('\\mathbb{R}')
  })

  it('filters by category and returns everything for an empty query', () => {
    expect(
      searchSymbols('', { category: 'greek' }).every((item) => item.category === 'greek'),
    ).toBe(true)
    expect(searchSymbols('')).toHaveLength(SYMBOLS.length)
    expect(searchSymbols('zzzz')).toEqual([])
  })
})

describe('recent symbols', () => {
  it('keeps a bounded list without duplicates, most recent first', () => {
    let recent: string[] = []
    recent = pushRecentSymbol(recent, '\\alpha')
    recent = pushRecentSymbol(recent, '\\beta')
    recent = pushRecentSymbol(recent, '\\alpha')
    expect(recent).toEqual(['\\alpha', '\\beta'])
    for (const item of SYMBOLS.slice(0, 40)) recent = pushRecentSymbol(recent, item.id)
    expect(recent).toHaveLength(RECENT_SYMBOLS_LIMIT)
    expect(pushRecentSymbol(['\\a', '\\b'], '\\c', 2)).toEqual(['\\c', '\\a'])
  })

  it('serializes and reads back, dropping unknown or invalid values', () => {
    const text = serializeRecentSymbols(['\\alpha', '\\in'])
    expect(parseRecentSymbols(text)).toEqual(['\\alpha', '\\in'])
    expect(parseRecentSymbols(['\\alpha', '\\unknown', 3, '\\alpha', '\\beta'])).toEqual([
      '\\alpha',
      '\\beta',
    ])
    expect(parseRecentSymbols('not json')).toEqual([])
    expect(parseRecentSymbols({ a: 1 })).toEqual([])
    expect(
      parseRecentSymbols(
        SYMBOLS.map((item) => item.id),
        3,
      ),
    ).toHaveLength(3)
    expect(recentSymbols(['\\beta', '\\nope']).map((item) => item.id)).toEqual(['\\beta'])
  })
})

describe('symbol insertion text', () => {
  it('inserts a math symbol as is in math mode, wrapped in \\( \\) otherwise', () => {
    expect(symbolSnippet(symbol('\\alpha'), { math: true })).toEqual({ text: '\\alpha', cursor: 6 })
    expect(symbolSnippet(symbol('\\alpha'), { math: true, next: 'x' })).toEqual({
      text: '\\alpha ',
      cursor: 7,
    })
    expect(symbolSnippet(symbol('\\alpha'), { math: false })).toEqual({
      text: '\\(\\alpha\\)',
      cursor: 10,
    })
  })

  it('puts the cursor or the selection in the argument of an accent', () => {
    expect(symbolSnippet(symbol('\\hat'), { math: true })).toEqual({ text: '\\hat{}', cursor: 5 })
    expect(symbolSnippet(symbol('\\hat'), { math: true, selection: 'x' })).toEqual({
      text: '\\hat{x}',
      cursor: 7,
    })
    expect(symbolSnippet(symbol('\\hat'), { math: false })).toEqual({
      text: '\\(\\hat{}\\)',
      cursor: 7,
    })
    expect(symbolSnippet(symbol("\\'"), { math: false, selection: 'e' })).toEqual({
      text: "\\'{e}",
      cursor: 5,
    })
  })

  it('wraps a text symbol in \\text inside a formula and protects a following letter', () => {
    expect(symbolSnippet(symbol('\\texteuro'), { math: true })).toEqual({
      text: '\\text{\\texteuro}',
      cursor: 16,
    })
    expect(symbolSnippet(symbol('\\S'), { math: false, next: 'a' })).toEqual({
      text: '\\S{}',
      cursor: 4,
    })
  })
})

describe('packages', () => {
  const doc = (packages: string) =>
    `\\documentclass{article}\n${packages}\n\\begin{document}\nx\n\\end{document}\n`

  it('lists the packages a formula needs', () => {
    expect(mathPackages('\\frac{a}{b} + \\sqrt{x}')).toEqual([])
    expect(mathPackages('\\text{si } x \\leqslant \\mathbb{R}')).toEqual([
      'amsmath',
      'amssymb',
      'amsfonts',
    ])
    expect(mathPackages('\\begin{pmatrix} a \\end{pmatrix}')).toEqual(['amsmath'])
    expect(mathPackages('x', 'align*')).toEqual(['amsmath'])
    expect(mathPackages('\\begin{dcases} a \\end{dcases} \\coloneqq')).toEqual(['mathtools'])
    expect(mathPackages('\\llbracket 1, n \\rrbracket')).toEqual(['stmaryrd'])
  })

  it('gives each library formula its packages', () => {
    for (const category of FORMULA_CATEGORIES) {
      expect(FORMULA_LIBRARY.some((item) => item.category === category.id)).toBe(true)
    }
    const byId = (id: string) => FORMULA_LIBRARY.find((item) => item.id === id)
    expect(byId('fraction')?.packages).toEqual([])
    expect(byId('pmatrix')?.packages).toEqual(['amsmath'])
    expect(byId('binomial')?.packages).toEqual(['amsmath'])
    expect(byId('cases')?.packages).toEqual(['amsmath'])
    expect(new Set(FORMULA_LIBRARY.map((item) => item.id)).size).toBe(FORMULA_LIBRARY.length)
    for (const item of FORMULA_LIBRARY) expect(item.template).not.toBe('')
  })

  it('detects missing packages, with providers', () => {
    expect(missingPackages(doc(''), ['amsmath', 'amssymb'])).toEqual(['amsmath', 'amssymb'])
    expect(missingPackages(doc('\\usepackage{mathtools}'), ['amsmath'])).toEqual([])
    expect(missingPackages(doc('\\usepackage{amssymb}'), ['amsfonts', 'amssymb'])).toEqual([])
    expect(missingPackages(doc('\\usepackage{amsmath,amssymb}'), ['amssymb', 'stmaryrd'])).toEqual([
      'stmaryrd',
    ])
    expect(missingPackages('just text', ['amsmath'])).toBeNull()
    expect(symbolMissingPackages(doc(''), symbol('\\leqslant'))).toEqual(['amssymb'])
    expect(symbolMissingPackages(doc('\\usepackage{amssymb}'), symbol('\\leqslant'))).toEqual([])
  })
})
