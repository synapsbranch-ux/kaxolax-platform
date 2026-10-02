import { logEntrySchema, MAX_MISSING_FILE_LENGTH } from '@kaxolax/contracts'
import { describe, expect, it } from 'vitest'
import { parseBiberLog, parseBibliographyLog, parseBibtexLog } from './bibliography.js'
import { parseCompileLogs } from './index.js'
import { parseLatexLog } from './latex.js'
import { normalizePath } from './paths.js'

const paths = { rootDir: '/compile', jobname: 'output' }

describe('normalizePath', () => {
  it.each([
    ['./main.tex', 'main.tex'],
    ['././chapters/intro.tex', 'chapters/intro.tex'],
    ['/compile/chapters/intro.tex', 'chapters/intro.tex'],
    ['"./my file.tex"', 'my file.tex'],
    [
      '/usr/local/texlive/2026/texmf-dist/tex/latex/base/article.cls',
      '/usr/local/texlive/2026/texmf-dist/tex/latex/base/article.cls',
    ],
    ['./output.aux', null],
    ['output.bbl', null],
    ['chapters/output.tex', 'chapters/output.tex'],
  ])('%s → %s', (input, expected) => {
    expect(normalizePath(input, paths)).toBe(expected)
  })
})

describe('parseLatexLog', () => {
  it('tracks files opened and closed on the same line and nested parentheses', () => {
    const log = [
      'This is pdfTeX, Version 3.14',
      '(./main.tex (./a.tex) (./b.tex (Font) text (with (nested) parens)',
      "LaTeX Warning: Reference `x' on page 1 undefined on input line 7.",
      ')',
      "LaTeX Warning: Citation `y' on page 1 undefined on input line 9.",
    ].join('\n')
    expect(parseLatexLog(log).map((entry) => [entry.file, entry.line])).toEqual([
      ['b.tex', 7],
      ['main.tex', 9],
    ])
  })

  it('reads quoted file names with spaces', () => {
    const log = [
      'This is pdfTeX',
      '("./my chapter.tex"',
      'LaTeX Warning: Something on input line 3.',
    ].join('\n')
    expect(parseLatexLog(log)[0]).toMatchObject({
      file: 'my chapter.tex',
      line: 3,
      message: 'Something',
    })
  })

  it('gives classic errors the line of their l.N context', () => {
    const log = [
      'This is pdfTeX',
      '(./main.tex',
      '! Undefined control sequence.',
      'l.12 \\foo',
      '        ',
      'help',
      '',
    ].join('\n')
    expect(parseLatexLog(log)[0]).toMatchObject({ level: 'error', file: 'main.tex', line: 12 })
  })

  it('merges LaTeX3 continuation lines into the message', () => {
    const log = [
      'This is pdfTeX',
      './main.tex:3: Package foo Error: first part',
      '(foo)                 second part.',
      '',
    ].join('\n')
    expect(parseLatexLog(log)[0]?.message).toBe('Package foo Error: first part second part.')
  })

  it('reports engine warnings', () => {
    const log = [
      'This is pdfTeX',
      '(./main.tex',
      'pdfTeX warning (ext4): destination with the same identifier',
      ')',
    ].join('\n')
    expect(parseLatexLog(log)[0]).toMatchObject({ level: 'warning', file: 'main.tex' })
  })

  it('strips a custom root directory and job name', () => {
    const log = [
      'This is pdfTeX',
      '/work/p1/chapters/a.tex:4: Undefined control sequence.',
      '(./paper.aux',
      'LaTeX Warning: Label x multiply defined.',
      ')',
    ].join('\n')
    const entries = parseLatexLog(log, { rootDir: '/work/p1', jobname: 'paper' })
    expect(entries.map((entry) => entry.file)).toEqual(['chapters/a.tex', null])
  })
})

describe('bibliography logs', () => {
  it('attaches a BibTeX warning to the following location line', () => {
    const blg = [
      'This is BibTeX, Version 0.99e',
      'Warning--string name "jan" is undefined',
      '--line 8 of file refs.bib',
    ].join('\n')
    expect(parseBibtexLog(blg)).toEqual([
      expect.objectContaining({
        level: 'warning',
        file: 'refs.bib',
        line: 8,
        message: 'string name "jan" is undefined',
      }),
    ])
  })

  it('reports BibTeX files it cannot open and errors while reading the aux file', () => {
    const blg = [
      'This is BibTeX, Version 0.99e',
      "I couldn't open database file missing.bib",
      'I found no \\citation commands---while reading file output.aux',
    ].join('\n')
    expect(parseBibtexLog(blg).map((entry) => [entry.level, entry.file])).toEqual([
      ['error', 'missing.bib'],
      ['error', null],
    ])
  })

  it('reports Biber errors and fatal errors', () => {
    const blg = [
      '[0] Config.pm:1> INFO - This is Biber 2.22',
      "[5] Biber.pm:1> ERROR - Cannot find 'refs.bib'!",
      '[6] Biber.pm:1> FATAL - boom',
    ].join('\n')
    expect(parseBiberLog(blg).map((entry) => [entry.level, entry.message])).toEqual([
      ['error', "Cannot find 'refs.bib'!"],
      ['error', 'boom'],
    ])
  })

  it('detects Biber and BibTeX logs', () => {
    expect(
      parseBibliographyLog('[0] Config.pm:1> INFO - x\n[1] Biber.pm:1> WARN - w'),
    ).toHaveLength(1)
    expect(parseBibliographyLog('This is BibTeX, Version 0.99e\nWarning--w')).toHaveLength(1)
  })
})

describe('parseCompileLogs', () => {
  it('caps the number of entries', () => {
    const log = [
      'This is pdfTeX',
      ...Array.from({ length: 50 }, (_, i) => `LaTeX Warning: warning ${i}.`),
    ].join('\n')
    expect(parseCompileLogs({ log }, { maxEntries: 10 })).toHaveLength(10)
  })

  it('does not repeat an identical message printed twice in a row', () => {
    const log = ['This is pdfTeX', './main.tex:3: Boom.', '', './main.tex:3: Boom.', ''].join('\n')
    expect(parseCompileLogs({ log })).toHaveLength(1)
  })
})

describe('missing files', () => {
  it('extracts the file of a TeX primitive \\input error', () => {
    const log = ['This is pdfTeX', "./main.tex:4: I can't find file `chapters/absent'.", ''].join(
      '\n',
    )
    expect(parseLatexLog(log)).toEqual([
      expect.objectContaining({ line: 4, missingFile: 'chapters/absent' }),
    ])
  })

  it('ignores a warning that mentions a missing file', () => {
    const log = ['This is pdfTeX', "LaTeX Warning: File `x.sty' not found on input line 2."].join(
      '\n',
    )
    expect(parseLatexLog(log)[0]?.missingFile).toBeUndefined()
  })

  it('drops an over-long missing file name but keeps the error valid', () => {
    const name = `${'a'.repeat(300)}.sty`
    const line = `! LaTeX Error: File \`${name}' not found.`
    // Log tel que TeX l'écrit : coupé à 79 colonnes.
    const wrapped = line.match(/.{1,79}/g) ?? []
    for (const log of [
      ['This is pdfTeX', line],
      ['This is pdfTeX', ...wrapped],
    ]) {
      const [entry] = parseLatexLog(log.join('\n'))
      expect(entry?.level).toBe('error')
      expect(entry?.message).toContain(name)
      expect(entry?.missingFile).toBeUndefined()
      expect(logEntrySchema.safeParse(entry).success).toBe(true)
    }
    const longest = `${'b'.repeat(MAX_MISSING_FILE_LENGTH - 4)}.sty`
    expect(parseLatexLog(`! LaTeX Error: File \`${longest}' not found.`)[0]?.missingFile).toBe(
      longest,
    )
  })

  it('reports the fatal summary in -file-line-error format only once', () => {
    const log = [
      'This is pdfTeX',
      "! LaTeX Error: File `artcle.cls' not found.",
      '',
      './main.tex:2:  ==> Fatal error occurred, no output PDF file produced!',
    ].join('\n')
    expect(parseLatexLog(log).map((entry) => entry.missingFile)).toEqual(['artcle.cls'])
    expect(
      parseLatexLog('./main.tex:2:  ==> Fatal error occurred, no output PDF file produced!'),
    ).toEqual([expect.objectContaining({ file: 'main.tex', line: 2 })])
  })
})
