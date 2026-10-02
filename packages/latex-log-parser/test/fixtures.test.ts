import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { logEntrySchema } from '@kaxolax/contracts'
import { describe, expect, it } from 'vitest'
import { parseCompileLogs } from '../src/index.js'

/**
 * Logs réels produits par TeX Live 2026 dans le sandbox (scripts/generate-fixtures.sh, sources
 * dans test/fixtures-src). Chaque attente : [niveau, fichier, ligne, début du message].
 */
type Expected = [level: string, file: string | null, line: number | null, message: string]

const fixtures: Record<string, Expected[]> = {
  'clean-article': [],
  'undefined-control-sequence': [['error', 'main.tex', 5, 'Undefined control sequence.']],
  'included-file-error': [['error', 'chapters/intro.tex', 3, 'Undefined control sequence.']],
  'missing-dollar': [
    ['error', 'main.tex', 3, 'Missing $ inserted.'],
    ['error', 'main.tex', 4, 'Missing $ inserted.'],
  ],
  'missing-package': [
    ['error', 'main.tex', 3, "LaTeX Error: File `thispackagedoesnotexist.sty' not found."],
  ],
  'runaway-argument': [
    ['error', null, null, 'File ended while scanning use of \\textbf'],
    ['error', null, null, 'job aborted, no legal \\end found'],
  ],
  'undefined-references': [
    ['warning', 'main.tex', null, "Label `sec:intro' multiply defined."],
    ['warning', 'main.tex', 4, "Reference `sec:missing' on page 1 undefined"],
    ['warning', 'main.tex', 4, "Citation `nobody2020' on page 1 undefined"],
    ['warning', 'main.tex', null, 'There were undefined references.'],
    ['warning', 'main.tex', null, 'There were multiply-defined labels.'],
  ],
  'bad-boxes': [
    ['typesetting', 'main.tex', 3, 'Overfull \\hbox (119.1781pt too wide) detected at line 3'],
    ['typesetting', 'main.tex', 5, 'Overfull \\hbox (54.86429pt too wide) in paragraph'],
    ['typesetting', 'main.tex', 8, 'Overfull \\hbox (100.40865pt too wide) in paragraph'],
    ['typesetting', 'main.tex', 11, 'Overfull \\vbox (56.90552pt too high) detected at line 11'],
    ['typesetting', 'main.tex', 13, 'Overfull \\hbox (419.57869pt too wide) in paragraph'],
  ],
  'package-warnings': [
    [
      'warning',
      'main.tex',
      4,
      "Package hyperref Warning: Token not allowed in a PDF string (Unicode): removing `math shift'",
    ],
    [
      'warning',
      'main.tex',
      4,
      "Package hyperref Warning: Token not allowed in a PDF string (Unicode): removing `superscript'",
    ],
    [
      'warning',
      'main.tex',
      4,
      "Package hyperref Warning: Token not allowed in a PDF string (Unicode): removing `math shift'",
    ],
    [
      'warning',
      'main.tex',
      5,
      "LaTeX Font Warning: Font shape `OT1/cmr/m/n' in size <3> not available size <5> substituted",
    ],
    ['warning', 'main.tex', 6, 'Package mypackage Warning: A custom warning spanning two lines'],
    ['warning', 'main.tex', 7, 'Class myclass Warning: A class warning'],
    [
      'warning',
      'main.tex',
      null,
      'LaTeX Font Warning: Size substitutions with differences up to 2.0pt have occurred.',
    ],
  ],
  'long-lines': [
    [
      'error',
      'very-long-directory-name-to-force-wrapping-of-paths/and-another-long-subdirectory/chapitre-avec-un-nom-très-long.tex',
      2,
      'Undefined control sequence.',
    ],
    [
      'warning',
      'very-long-directory-name-to-force-wrapping-of-paths/and-another-long-subdirectory/chapitre-avec-un-nom-très-long.tex',
      3,
      'Package longpkg Warning: Un avertissement très long avec des accents éèàùç et suffisamment de mots pour dépasser largement la limite de soixante-dix-neuf caractères imposée par TeX',
    ],
    [
      'typesetting',
      'main.tex',
      4,
      'Overfull \\hbox (1.85243pt too wide) in paragraph at lines 4--6',
    ],
  ],
  'xelatex-missing-character': [
    [
      'warning',
      'main.tex',
      null,
      'Missing character: There is no 漢 (U+6F22) in font Latin Modern Roman 10 Regular/OT:script=latn;language=dflt;mapping=tex-text;!',
    ],
    [
      'warning',
      'main.tex',
      null,
      'Missing character: There is no 字 (U+5B57) in font Latin Modern Roman 10 Regular/OT:script=latn;language=dflt;mapping=tex-text;!',
    ],
    [
      'error',
      'main.tex',
      7,
      'Package fontspec Error: The font "Font That Does Not Exist" cannot be found;',
    ],
    [
      'error',
      'main.tex',
      7,
      'Font TU/FontThatDoesNotExist(0)/m/n/10="Font That Does Not Exist" at 10.0pt not loadable',
    ],
  ],
  'lualatex-lua-error': [['error', 'main.tex', 4, "attempt to index a nil value (local 't')"]],
  'bibtex-warnings': [
    ['warning', 'main.tex', 3, "Citation `absent1999' on page 1 undefined"],
    ['warning', 'main.tex', null, 'There were undefined references.'],
    ['warning', null, null, 'I didn\'t find a database entry for "absent1999"'],
    ['warning', null, null, 'empty journal in incomplete2020'],
    ['warning', null, null, 'empty year in incomplete2020'],
  ],
  'bibtex-syntax-error': [
    ['error', 'refs.bib', 9, "I was expecting a `,' or a `}'"],
    ['warning', null, null, 'to sort, need author, editor, or key in broken2002'],
    ['warning', null, null, 'empty author and editor in broken2002'],
    ['warning', null, null, 'empty title in broken2002'],
    ['warning', null, null, 'empty publisher in broken2002'],
    ['warning', null, null, 'empty year in broken2002'],
  ],
  'biber-warnings': [
    [
      'warning',
      'main.tex',
      null,
      'Package biblatex Warning: The following entry could not be found in the database: missing2010',
    ],
    ['warning', 'main.tex', 5, "Citation 'missing2010' on page 1 undefined"],
    [
      'warning',
      'main.tex',
      6,
      "Package biblatex Warning: Month out of range or not an integer at entry 'lamport1994'",
    ],
    [
      'warning',
      null,
      null,
      "legacy month field 'thirteenth' in entry 'lamport1994' is not an integer",
    ],
    ['warning', null, null, "I didn't find a database entry for 'missing2010' (section 0)"],
  ],
  'biber-syntax-error': [
    ['warning', 'main.tex', 5, "Citation 'ok2001' on page 1 undefined"],
    ['warning', 'main.tex', 6, 'Empty bibliography'],
    ['warning', 'main.tex', null, 'There were undefined references.'],
    [
      'warning',
      'main.tex',
      null,
      'Package biblatex Warning: Please (re)run Biber on the file: output and rerun LaTeX afterwards.',
    ],
    ['error', 'refs.bib', 12, 'syntax error: at end of input, expected end of entry'],
    ['warning', 'refs.bib', 10, 'warning: possible runaway string started at line 9'],
  ],
  'classic-error-format': [
    ['error', 'main.tex', 4, 'Undefined control sequence.'],
    ['error', 'main.tex', 5, "LaTeX Error: File `missing-file-that-does-not-exist.tex' not found."],
  ],
  'nested-files': [
    ['error', 'chapters/sections/deep.tex', 2, "LaTeX Error: File `missing-image' not found."],
    ['warning', 'chapters/sections/deep.tex', 3, "Reference `nowhere' on page 1 undefined"],
    ['error', 'chapters/one.tex', 4, 'Undefined control sequence.'],
    ['error', 'main.tex', 7, 'Undefined control sequence.'],
    ['warning', 'main.tex', null, 'There were undefined references.'],
  ],
  'environment-mismatch': [
    [
      'error',
      'main.tex',
      6,
      'LaTeX Error: \\begin{itemize} on input line 3 ended by \\end{enumerate}.',
    ],
  ],
  'fatal-no-end': [['error', null, null, 'job aborted, no legal \\end found']],
  'xelatex-missing-package': [
    ['error', 'main.tex', 4, "LaTeX Error: File `graphix.sty' not found."],
  ],
  'lualatex-missing-package': [
    ['error', 'main.tex', 3, "LaTeX Error: File `hyperef.sty' not found."],
  ],
  'missing-class': [['error', 'main.tex', 2, "LaTeX Error: File `artcle.cls' not found."]],
}

const fixturesDir = join(import.meta.dirname, 'fixtures')

function load(name: string) {
  const log = readFileSync(join(fixturesDir, name, 'output.log'))
  const blgPath = join(fixturesDir, name, 'output.blg')
  const blg = existsSync(blgPath) ? readFileSync(blgPath) : null
  return parseCompileLogs({ log, blg })
}

describe('real TeX Live 2026 logs', () => {
  it('covers at least 15 fixtures', () => {
    expect(Object.keys(fixtures).length).toBeGreaterThanOrEqual(15)
  })

  it.each(Object.entries(fixtures))('%s', (name, expected) => {
    const entries = load(name)
    const summary = entries.map((entry) => [entry.level, entry.file, entry.line, entry.message])
    expect(summary).toHaveLength(expected.length)
    expected.forEach(([level, file, line, message], index) => {
      expect(summary[index]?.slice(0, 3)).toEqual([level, file, line])
      expect(
        entries[index]?.message.startsWith(message),
        `${entries[index]?.message} / ${message}`,
      ).toBe(true)
    })
    for (const entry of entries) {
      expect(logEntrySchema.parse(entry)).toEqual(entry)
      expect(entry.raw.length).toBeGreaterThan(0)
    }
  })

  it.each([
    ['missing-package', 'thispackagedoesnotexist.sty'],
    ['xelatex-missing-package', 'graphix.sty'],
    ['lualatex-missing-package', 'hyperef.sty'],
    ['missing-class', 'artcle.cls'],
    ['classic-error-format', 'missing-file-that-does-not-exist.tex'],
    ['nested-files', 'missing-image'],
  ])('extracts the missing file of %s', (name, missingFile) => {
    const entries = load(name)
    expect(entries.filter((entry) => entry.missingFile !== undefined)).toEqual([
      expect.objectContaining({ level: 'error', missingFile }),
    ])
  })

  it('keeps the TeX context in the raw text of an error', () => {
    const [error] = load('included-file-error')
    expect(error?.raw).toContain('l.3 Line three with \\badcommand')
  })
})
