import { describe, expect, it } from 'vitest'
import {
  findFormulas,
  formatFormula,
  formulaAt,
  fromMathfield,
  hasTopLevel,
  inMath,
  mathfieldValue,
  rewriteFormula,
} from './formula.js'

/** Position du marqueur `|` et texte sans lui. */
function at(marked: string): { doc: string; pos: number } {
  const pos = marked.indexOf('|')
  return { doc: marked.slice(0, pos) + marked.slice(pos + 1), pos }
}

describe('findFormulas', () => {
  it('finds every delimiter and math environment', () => {
    const doc = [
      'a \\(x\\) b $y$ c',
      '\\[ z \\]',
      '$$w$$',
      '\\begin{equation} e \\end{equation}',
      '\\begin{equation*} f \\end{equation*}',
      '\\begin{align} g &= h \\end{align}',
      '\\begin{align*} i \\end{align*}',
      '\\begin{gather} j \\end{gather}',
      '\\begin{multline} k \\end{multline}',
    ].join('\n')
    const found = findFormulas(doc)
    expect(found.map((match) => [match.delimiter, match.environment ?? null, match.body])).toEqual([
      ['\\(', null, 'x'],
      ['$', null, 'y'],
      ['\\[', null, 'z'],
      ['$$', null, 'w'],
      ['environment', 'equation', 'e'],
      ['environment', 'equation*', 'f'],
      ['environment', 'align', 'g &= h'],
      ['environment', 'align*', 'i'],
      ['environment', 'gather', 'j'],
      ['environment', 'multline', 'k'],
    ])
    expect(found.map((match) => match.style)).toEqual([
      'inline',
      'inline',
      'display',
      'display',
      'equation',
      'display',
      'equation',
      'display',
      'equation',
      'equation',
    ])
    for (const match of found) expect(doc.slice(match.from, match.to)).toBe(match.text)
  })

  it('ignores escaped dollars, comments and verbatim', () => {
    const doc = [
      'Price \\$5 and \\$6.',
      '% $not math$',
      '\\verb|$x$| text',
      '\\begin{verbatim}',
      '$y$',
      '\\end{verbatim}',
      'real $z$',
    ].join('\n')
    expect(findFormulas(doc).map((match) => match.body)).toEqual(['z'])
  })

  it('keeps dollars inside \\text of a display formula', () => {
    const doc = '\\begin{equation} a = \\text{if $b$} \\end{equation}'
    const [match] = findFormulas(doc)
    expect(match?.body).toBe('a = \\text{if $b$}')
    expect(findFormulas(doc)).toHaveLength(1)
  })

  it('drops an inline formula interrupted by a blank line', () => {
    expect(findFormulas('a $b\n\nc $d$').map((match) => match.body)).toEqual(['d'])
    expect(findFormulas('a \\(b\n  \nc').map((match) => match.body)).toEqual([])
  })

  it('extracts a single leading or trailing \\label', () => {
    const doc = '\\begin{equation}\n  \\label{eq:a}\n  x = 1\n\\end{equation}'
    const [match] = findFormulas(doc)
    expect(match?.label?.name).toBe('eq:a')
    expect(match?.body).toBe('x = 1')
    const trailing = findFormulas('\\begin{equation} y \\label{eq:b} \\end{equation}')[0]
    expect(trailing?.label?.name).toBe('eq:b')
    expect(trailing?.body).toBe('y')
    // Plusieurs labels (align) : laissés dans la formule.
    const align = findFormulas('\\begin{align} a \\label{x} \\\\ b \\label{y} \\end{align}')[0]
    expect(align?.label).toBeUndefined()
    expect(align?.body).toBe('a \\label{x} \\\\ b \\label{y}')
  })
})

describe('formulaAt', () => {
  it('finds the formula under the cursor', () => {
    const { doc, pos } = at('a $x |+ y$ b')
    expect(formulaAt(doc, pos)?.body).toBe('x + y')
  })

  it('needs the cursor strictly inside an inline formula', () => {
    expect(formulaAt(...(Object.values(at('a |$x$ b')) as [string, number]))).toBeNull()
    expect(formulaAt(...(Object.values(at('a $x$| b')) as [string, number]))).toBeNull()
    expect(formulaAt(...(Object.values(at('a $|x$ b')) as [string, number]))?.body).toBe('x')
  })

  it('accepts the delimiters of a display formula', () => {
    const { doc, pos } = at('|\\begin{equation}x\\end{equation}')
    expect(formulaAt(doc, pos)?.environment).toBe('equation')
    const end = at('\\[x\\]|')
    expect(formulaAt(end.doc, end.pos)?.delimiter).toBe('\\[')
  })

  it('requires the whole selection inside the formula', () => {
    const doc = 'a $x$ b'
    expect(formulaAt(doc, 3, 4)?.body).toBe('x')
    expect(formulaAt(doc, 0, 4)).toBeNull()
  })

  it('tells whether a position is in math mode', () => {
    expect(inMath('a $x$ b', 3)).toBe(true)
    expect(inMath('a $x$ b', 6)).toBe(false)
  })
})

describe('rewriteFormula', () => {
  const doc = 'Text \\begin{equation}\n\t\\label{eq:one}\n\ta = b\n\\end{equation} end'
  const match = findFormulas(doc)[0]
  if (!match) throw new Error('formula expected')

  it('gives back the exact text when nothing changes', () => {
    for (const source of [
      doc,
      'x \\( a \\) y',
      '$a$',
      '$$ a $$',
      '\\[\n  a\n\\]',
      '\\begin{align*}\n  a &= b \\\\\n  c &= d\n\\end{align*}',
      '\\begin{equation} a \\label{t} \\end{equation}',
    ]) {
      for (const item of findFormulas(source)) {
        const out = rewriteFormula(item, {
          body: item.body,
          style: item.style,
          label: item.label?.name ?? '',
        })
        expect(out).toBe(item.text)
      }
    }
  })

  it('replaces only the formula and keeps label, environment and spacing', () => {
    expect(rewriteFormula(match, { body: 'a = c', style: 'equation', label: 'eq:one' })).toBe(
      '\\begin{equation}\n\t\\label{eq:one}\n\ta = c\n\\end{equation}',
    )
    const align = findFormulas('\\begin{align}\n  a &= b\n\\end{align}')[0]
    if (!align) throw new Error('formula expected')
    expect(rewriteFormula(align, { body: 'a &= c', style: 'equation' })).toBe(
      '\\begin{align}\n  a &= c\n\\end{align}',
    )
    const inline = findFormulas('$x$')[0]
    if (!inline) throw new Error('formula expected')
    expect(rewriteFormula(inline, { body: 'y^2', style: 'inline' })).toBe('$y^2$')
  })

  it('renames, removes or adds the label', () => {
    expect(rewriteFormula(match, { body: 'a = b', style: 'equation', label: 'eq:two' })).toBe(
      '\\begin{equation}\n\t\\label{eq:two}\n\ta = b\n\\end{equation}',
    )
    expect(rewriteFormula(match, { body: 'a = b', style: 'equation', label: '' })).toBe(
      '\\begin{equation}\n\ta = b\n\\end{equation}',
    )
    const bare = findFormulas('\\begin{equation}\n\tx\n\\end{equation}')[0]
    if (!bare) throw new Error('formula expected')
    expect(rewriteFormula(bare, { body: 'x', style: 'equation', label: 'eq:x' })).toBe(
      '\\begin{equation}\n\t\\label{eq:x}\n\tx\n\\end{equation}',
    )
    const trailing = findFormulas('\\begin{equation} y \\label{eq:b} \\end{equation}')[0]
    if (!trailing) throw new Error('formula expected')
    expect(rewriteFormula(trailing, { body: 'y', style: 'equation', label: '' })).toBe(
      '\\begin{equation} y \\end{equation}',
    )
  })

  it('reformats when the style changes', () => {
    expect(rewriteFormula(match, { body: 'a = b', style: 'inline' })).toBe('\\(a = b\\)')
    expect(rewriteFormula(match, { body: 'a = b', style: 'display' })).toBe('\\[\n\ta = b\n\\]')
  })
})

describe('formatFormula', () => {
  it('writes inline, display and numbered formulas', () => {
    expect(formatFormula({ body: ' x^2 ', style: 'inline' })).toBe('\\(x^2\\)')
    expect(formatFormula({ body: 'x^2', style: 'display' })).toBe('\\[\n\tx^2\n\\]')
    expect(formatFormula({ body: 'x^2', style: 'equation' })).toBe(
      '\\begin{equation}\n\tx^2\n\\end{equation}',
    )
    expect(formatFormula({ body: 'x^2', style: 'equation', label: 'eq:sq' })).toBe(
      '\\begin{equation}\n\t\\label{eq:sq}\n\tx^2\n\\end{equation}',
    )
  })

  it('wraps a multi-line formula so that it compiles', () => {
    expect(formatFormula({ body: 'a &= b \\\\ c &= d', style: 'equation' })).toBe(
      '\\begin{equation}\n\t\\begin{split}\n\t\ta &= b \\\\\n\t\tc &= d\n\t\\end{split}\n\\end{equation}',
    )
    expect(formatFormula({ body: 'a \\\\ b', style: 'inline' })).toBe(
      '\\(\\begin{aligned}a \\\\ b\\end{aligned}\\)',
    )
    // `\\` à l'intérieur d'un environnement : rien à ajouter.
    expect(
      formatFormula({ body: '\\begin{pmatrix} a \\\\ b \\end{pmatrix}', style: 'display' }),
    ).toBe('\\[\n\t\\begin{pmatrix} a \\\\ b \\end{pmatrix}\n\\]')
  })
})

describe('MathLive round trip', () => {
  it('presents multi-line environments in aligned or gathered', () => {
    const align = findFormulas('\\begin{align*} a &= b \\\\ c &= d \\end{align*}')[0] ?? null
    const value = mathfieldValue(align)
    expect(value).toEqual({
      value: '\\begin{aligned}a &= b \\\\ c &= d\\end{aligned}',
      wrapper: 'aligned',
    })
    expect(fromMathfield(value.value, value.wrapper)).toBe('a &= b \\\\ c &= d')
    const gather = findFormulas('\\begin{gather} a \\\\ b \\end{gather}')[0] ?? null
    expect(mathfieldValue(gather).wrapper).toBe('gathered')
    expect(mathfieldValue(findFormulas('$x$')[0] ?? null)).toEqual({ value: 'x' })
    expect(mathfieldValue(null)).toEqual({ value: '' })
  })

  it('keeps an edited value that no longer fits the wrapper', () => {
    const edited = '\\begin{aligned}a\\end{aligned}+\\begin{aligned}b\\end{aligned}'
    expect(fromMathfield(edited, 'aligned')).toBe(edited)
    expect(fromMathfield('x', 'aligned')).toBe('x')
  })

  it('detects top-level row and column separators', () => {
    expect(hasTopLevel('a \\\\ b', '\\\\')).toBe(true)
    expect(hasTopLevel('\\begin{cases} a \\\\ b \\end{cases}', '\\\\')).toBe(false)
    expect(hasTopLevel('{a & b}', '&')).toBe(false)
    expect(hasTopLevel('a & b', '&')).toBe(true)
  })
})
