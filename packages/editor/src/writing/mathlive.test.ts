import { describe, expect, it } from 'vitest'
import {
  hasLatexComment,
  MATHLIVE_REPLACEMENTS,
  normalizeMathLive,
  sanitizeForMathLive,
  stripLatexComments,
} from './mathlive.js'

describe('normalizeMathLive', () => {
  it('converts every MathLive-specific command of the table', () => {
    const expected: Record<string, string> = {
      '\\exponentialE': 'e',
      '\\imaginaryI': 'i',
      '\\imaginaryJ': 'j',
      '\\differentialD': '\\mathrm{d}',
      '\\capitalDifferentialD': '\\mathrm{D}',
      '\\mleft': '\\left',
      '\\mright': '\\right',
      '\\lparen': '(',
      '\\rparen': ')',
      '\\lt': '<',
      '\\gt': '>',
      '\\coloneq': '\\mathrel{:}=',
      '\\Colon': '\\mathrel{::}',
      '\\N': '\\mathbb{N}',
      '\\Z': '\\mathbb{Z}',
      '\\Q': '\\mathbb{Q}',
      '\\R': '\\mathbb{R}',
      '\\C': '\\mathbb{C}',
      '\\infin': '\\infty',
    }
    expect(
      Object.fromEntries(MATHLIVE_REPLACEMENTS.map((item) => [item.command, item.latex])),
    ).toEqual(expected)
    for (const [command, latex] of Object.entries(expected)) {
      expect(normalizeMathLive(command).latex).toBe(latex)
    }
  })

  it('normalizes a typical MathLive integral', () => {
    expect(normalizeMathLive('\\int_0^1\\exponentialE^{x}\\,\\differentialD x').latex).toBe(
      '\\int_0^1e^{x}\\,\\mathrm{d} x',
    )
    expect(normalizeMathLive('\\mleft(\\frac{1}{2}\\mright)').latex).toBe(
      '\\left(\\frac{1}{2}\\right)',
    )
  })

  it('does not touch longer commands that share a prefix', () => {
    expect(normalizeMathLive('\\ltimes \\Rightarrow \\coloneqq \\Colonequals').latex).toBe(
      '\\ltimes \\Rightarrow \\coloneqq \\Colonequals',
    )
  })

  it('keeps a letter after a replaced command separated', () => {
    expect(normalizeMathLive('\\mleft\\lbrace x\\mright.').latex).toBe('\\left\\lbrace x\\right.')
    expect(normalizeMathLive('\\R x').latex).toBe('\\mathbb{R} x')
    expect(normalizeMathLive('\\lt\\imaginaryI\\exponentialE').latex).toBe('< i e')
    expect(normalizeMathLive('\\alpha\\exponentialE^{x}').latex).toBe('\\alpha e^{x}')
  })

  it('removes placeholders and HTML display commands', () => {
    expect(normalizeMathLive('\\frac{\\placeholder{}}{\\placeholder[b]{}}').latex).toBe(
      '\\frac{}{}',
    )
    expect(normalizeMathLive('\\class{red}{x}+\\cssId{a}{y}').latex).toBe('x+y')
  })

  it('converts hexadecimal colours for xcolor and reports the package', () => {
    const result = normalizeMathLive('\\textcolor{#ff0000}{x}+\\color{#0f0}y')
    expect(result.latex).toBe('\\textcolor[HTML]{FF0000}{x}+\\color[HTML]{00FF00}y')
    expect(result.packages).toEqual(['xcolor'])
    expect(normalizeMathLive('\\cancel{x}').packages).toEqual(['cancel'])
  })

  it('collapses whitespace without gluing commands to letters', () => {
    expect(normalizeMathLive('  \\alpha   x  +  \\frac {a} {b}  ').latex).toBe(
      '\\alpha x + \\frac{a} {b}',
    )
    // Sauts de ligne et indentation gardés, lignes vides retirées (erreur en mode mathématique).
    expect(normalizeMathLive('a \\\\  \n\n  b').latex).toBe('a \\\\\n  b')
  })

  it('warns about commands without a LaTeX equivalent', () => {
    expect(normalizeMathLive('\\unicode{"2A00}').warnings).toEqual(['\\unicode'])
    expect(normalizeMathLive('x').warnings).toEqual([])
  })
})

describe('comments and line breaks', () => {
  it('never lets a comment swallow the rest of the formula', () => {
    expect(normalizeMathLive('a = B % premier terme\n  + c').latex).toBe(
      'a = B % premier terme\n  + c',
    )
    // `\%` n'est pas un commentaire ; le texte d'un commentaire n'est pas normalisé.
    expect(normalizeMathLive('50\\%  +  x % \\lt  note').latex).toBe('50\\% + x % \\lt  note')
    expect(hasLatexComment('a % b')).toBe(true)
    expect(hasLatexComment('a \\% b')).toBe(false)
    expect(stripLatexComments('a % b\n+ c')).toBe('a  + c')
  })
})

describe('sanitizeForMathLive', () => {
  it('drops the HTML extensions of MathLive and keeps their content', () => {
    expect(
      sanitizeForMathLive(
        '\\href{https://evil.example}{\\htmlStyle{background:url(https://evil.example/p)}{x}}+y',
      ),
    ).toBe('x+y')
    expect(sanitizeForMathLive('\\class{a}{b}\\htmlClass{a}{c}\\cssId{i}{d}\\htmlId{i}{e}')).toBe(
      'bcde',
    )
    expect(sanitizeForMathLive('\\htmlData{k=v}{f}\\style{color:red}{g}')).toBe('fg')
    // Sans argument entre accolades : la commande seule disparaît.
    expect(sanitizeForMathLive('\\href x')).toBe('x')
    expect(sanitizeForMathLive('\\frac{a}{b}')).toBe('\\frac{a}{b}')
  })

  it('removes commands rebuilt by an earlier removal', () => {
    const rebuilt = [
      '\\htmlSt\\style yle{background:url(https://evil/p)}{x}',
      '\\hr\\style ef{https://evil}{x}',
      '\\hr\\style{a}{ef}{https://evil}{x}',
      '\\hr\\htmlSt\\style yle ef{https://evil}{x}',
      '\\cl\\htmlId ass{a}{x}',
    ]
    for (const input of rebuilt) {
      const output = sanitizeForMathLive(input)
      expect(output).not.toMatch(
        /\\(href|class|htmlClass|cssId|htmlId|htmlData|htmlStyle|style)(?![a-zA-Z])/,
      )
      expect(output).not.toContain('evil')
    }
    expect(normalizeMathLive('\\htmlSt\\style yle{color:red}{x}').latex).not.toContain('htmlStyle')
  })
})
