import type { LogEntry, WordCountSection } from '@kaxolax/contracts'
import { editorSettings, ProjectIndex } from '@kaxolax/editor'
import { describe, expect, it } from 'vitest'
import { ApiError, type ProjectTree } from './api'
import {
  fontChoice,
  isSpellcheckedPath,
  isValidCustomFont,
  nearest,
  settingsChange,
  spellcheckErrorMessage,
} from './editor-settings'
import { PackageNameCache, normalizeQuery, packageNamesOf } from './package-names'
import {
  addPackageMessage,
  isPackageManagerPayload,
  missingPackageOf,
  parsePackageOptions,
  planRenamePackage,
  texliveErrorMessage,
} from './package-tools'
import { indexedDocuments, treeRenames } from './project-index'
import { formatCount, sectionTitle, wordCountErrorMessage, wordCountRows } from './word-count'

function entry(overrides: Partial<LogEntry>): LogEntry {
  return { level: 'error', file: 'main.tex', line: 3, message: '', raw: '', ...overrides }
}

function apply(text: string, change: { from: number; to: number; insert: string }): string {
  return text.slice(0, change.from) + change.insert + text.slice(change.to)
}

describe('missingPackageOf', () => {
  it('reads a missing package or class from the parsed log', () => {
    expect(missingPackageOf(entry({ missingFile: 'graphix.sty' }))).toEqual({
      name: 'graphix',
      kind: 'package',
      file: 'graphix.sty',
    })
    expect(missingPackageOf(entry({ missingFile: 'artcle.cls' }))?.kind).toBe('class')
  })

  it('ignores other missing files and other entries', () => {
    expect(missingPackageOf(entry({ missingFile: 'chapitre.tex' }))).toBeNull()
    expect(missingPackageOf(entry({ missingFile: 'chapters/absent' }))).toBeNull()
    expect(missingPackageOf(entry({}))).toBeNull()
    expect(missingPackageOf(entry({ level: 'warning', missingFile: 'x.sty' }))).toBeNull()
  })
})

describe('planRenamePackage', () => {
  it('replaces only the misspelled name, keeping options and the list', () => {
    const text =
      '\\documentclass{article}\n\\usepackage[utf8]{inputenc}\n\\usepackage[final]{amsmath, graphix ,xcolor}\n'
    const plan = planRenamePackage(text, 'package', 'graphix', 'graphicx')
    expect(plan?.line).toBe(3)
    expect(plan && apply(text, plan)).toBe(
      '\\documentclass{article}\n\\usepackage[utf8]{inputenc}\n\\usepackage[final]{amsmath, graphicx ,xcolor}\n',
    )
  })

  it('handles lists over several lines with comments, and \\RequirePackage', () => {
    const text = '\\RequirePackage{%\n  amsmth, % maths\n  tikz}\n'
    const plan = planRenamePackage(text, 'package', 'amsmth', 'amsmath')
    expect(plan && apply(text, plan)).toBe('\\RequirePackage{%\n  amsmath, % maths\n  tikz}\n')
  })

  it('ignores commented commands and names that only contain the misspelling', () => {
    const text = '% \\usepackage{graphix}\n\\usepackage{graphixtra}\n\\usepackage{graphix}\n'
    const plan = planRenamePackage(text, 'package', 'graphix', 'graphicx')
    expect(plan?.line).toBe(3)
    expect(plan && apply(text, plan)).toContain('\\usepackage{graphixtra}\n\\usepackage{graphicx}')
    expect(planRenamePackage('\\usepackage{other}', 'package', 'graphix', 'x')).toBeNull()
  })

  it('prefers the command on the line of the log', () => {
    const text = '\\usepackage{foo}\n\\usepackage{bar}\n\\usepackage{foo}\n'
    expect(planRenamePackage(text, 'package', 'foo', 'baz', 3)?.line).toBe(3)
    expect(planRenamePackage(text, 'package', 'foo', 'baz', 2)?.line).toBe(1)
    expect(planRenamePackage(text, 'package', 'foo', 'baz', null)?.line).toBe(1)
  })

  it('fixes the document class', () => {
    const text = '\\documentclass[a4paper]{artcle}\n\\usepackage{artcle}\n'
    const plan = planRenamePackage(text, 'class', 'artcle', 'article')
    expect(plan && apply(text, plan)).toBe(
      '\\documentclass[a4paper]{article}\n\\usepackage{artcle}\n',
    )
  })
})

describe('parsePackageOptions', () => {
  it('cleans a comma-separated list', () => {
    expect(parsePackageOptions(' margin=2cm, a4paper ,, ')).toEqual(['margin=2cm', 'a4paper'])
    expect(parsePackageOptions('')).toEqual([])
    expect(parsePackageOptions('style={a,b}, x')).toEqual(['style={a,b}', 'x'])
  })

  it('rejects options that would break out of the brackets', () => {
    expect(parsePackageOptions('a]')).toBeNull()
    expect(parsePackageOptions('\\input{x}')).toBeNull()
    expect(parsePackageOptions('x}')).toBeNull()
    expect(parsePackageOptions('a % b')).toBeNull()
  })
})

describe('package manager helpers', () => {
  it('checks the dialog payload', () => {
    expect(
      isPackageManagerPayload({
        kind: 'packages',
        packages: [],
        hasPreamble: true,
        readOnly: false,
      }),
    ).toBe(true)
    expect(isPackageManagerPayload({ kind: 'packages', packages: [] })).toBe(false)
    expect(isPackageManagerPayload(null)).toBe(false)
  })

  it('translates statuses and API errors', () => {
    expect(addPackageMessage('siunitx', 'insert')).toEqual({
      message: '\\usepackage{siunitx} ajouté au préambule.',
      level: 'info',
    })
    expect(addPackageMessage('x', 'conflict').level).toBe('warning')
    expect(
      texliveErrorMessage(new ApiError(503, 'E_PACKAGE_INDEX_UNAVAILABLE', 'Unavailable')),
    ).toContain('indisponible')
    expect(texliveErrorMessage(new ApiError(404, 'E_NOT_FOUND', 'Not found'))).toContain(
      'introuvable',
    )
  })
})

describe('PackageNameCache', () => {
  it('skips queries already answered completely', () => {
    const cache = new PackageNameCache()
    expect(cache.shouldQuery('g')).toBe(false)
    expect(cache.shouldQuery('gr')).toBe(true)
    expect(cache.record('gr', ['graphicx', 'grfext'], true)).toBe(true)
    expect(cache.shouldQuery('gr')).toBe(false)
    expect(cache.shouldQuery('GRA')).toBe(false)
    expect(cache.record('ti', ['tikz'], false)).toBe(true)
    expect(cache.shouldQuery('tik')).toBe(true)
    expect(cache.record('tik', ['tikz'], true)).toBe(false)
    expect(cache.list()).toEqual(['graphicx', 'grfext', 'tikz'])
  })

  it('learns the matching style files beyond the first ones', () => {
    const entry = {
      name: 'koma-script',
      shortdesc: null,
      category: 'Package',
      topics: [],
      ctanUrl: null,
      docUrl: 'https://texdoc.org/pkg/koma-script',
      usepackage: ['scrbase', 'scrdate'],
    }
    const list = { texliveYear: 2026, total: 1, page: 1, perPage: 50 }
    expect(
      packageNamesOf({ ...list, packages: [{ ...entry, matchingUsepackage: ['typearea'] }] }),
    ).toEqual({ names: ['scrbase', 'scrdate', 'typearea'], complete: true })
    // Ancienne réponse sans les noms correspondants, ou liste coupée : à redemander.
    expect(packageNamesOf({ ...list, packages: [entry] }).complete).toBe(false)
    const many = Array.from({ length: 100 }, (_, index) => `pgf${String(index)}`)
    expect(
      packageNamesOf({ ...list, packages: [{ ...entry, matchingUsepackage: many }] }).complete,
    ).toBe(false)
    expect(
      packageNamesOf({ ...list, total: 2, packages: [{ ...entry, matchingUsepackage: [] }] })
        .complete,
    ).toBe(false)
  })

  it('normalizes searchable prefixes', () => {
    expect(normalizeQuery(' Amsm ')).toBe('amsm')
    expect(normalizeQuery('a b')).toBeNull()
    expect(normalizeQuery('a')).toBeNull()
  })
})

describe('word count', () => {
  const section = (overrides: Partial<WordCountSection>): WordCountSection => ({
    kind: 'section',
    title: 'Titre',
    words: 10,
    text: 8,
    headers: 2,
    captions: 0,
    headerCount: 1,
    floatCount: 0,
    inlineMathCount: 0,
    displayMathCount: 0,
    ...overrides,
  })

  it('indents sections relative to the top level of the document', () => {
    const rows = wordCountRows([
      section({ kind: 'top', title: '', words: 0 }),
      section({ kind: 'section', title: 'Introduction' }),
      section({ kind: 'subsection', title: 'Contexte' }),
      section({ kind: 'section', title: 'Méthodes' }),
    ])
    expect(rows.map((row) => [row.title, row.depth])).toEqual([
      ['Introduction', 0],
      ['Contexte', 1],
      ['Méthodes', 0],
    ])
    expect(wordCountRows([section({ kind: 'top', title: '', words: 5 })])[0]?.depth).toBe(0)
  })

  it('formats counts, titles and errors', () => {
    expect(formatCount(12345).replace(/\s/g, ' ')).toBe('12 345')
    expect(sectionTitle(section({ kind: 'chapter', title: '  ' }))).toBe('Chapitre')
    expect(
      wordCountErrorMessage(new ApiError(422, 'E_NO_MAIN_DOCUMENT', 'Choose the main document')),
    ).toContain('document principal')
    expect(
      wordCountErrorMessage(
        new ApiError(429, 'E_WORD_COUNT_BUSY', 'A word count is already running'),
      ),
    ).toContain('déjà en cours')
    expect(wordCountErrorMessage(new Error('offline'))).toContain('offline')
  })
})

describe('project index', () => {
  const tree: ProjectTree = {
    mainDocumentId: 'a',
    folders: [],
    documents: [
      { id: 'a', folderId: null, name: 'main.tex', path: 'main.tex' },
      { id: 'b', folderId: null, name: 'refs.bib', path: 'refs.bib' },
      { id: 'c', folderId: null, name: 'notes.txt', path: 'notes.txt' },
      { id: 'd', folderId: null, name: 'intro.tex', path: 'chapitres/intro.tex' },
    ],
    files: [],
  }

  it('reads LaTeX and BibTeX documents, .bib first, within the limit', () => {
    expect(indexedDocuments(tree).map((document) => document.id)).toEqual(['b', 'd', 'a'])
    expect(indexedDocuments(tree, 2).map((document) => document.id)).toEqual(['b', 'd'])
  })

  it('detects renamed documents', () => {
    const previous = new Map([
      ['a', 'main.tex'],
      ['d', 'intro.tex'],
    ])
    expect(treeRenames(previous, tree)).toEqual([{ from: 'intro.tex', to: 'chapitres/intro.tex' }])
  })

  it('answers \\cite completions from many keys quickly', () => {
    const index = new ProjectIndex()
    const bib = Array.from(
      { length: 5000 },
      (_, i) =>
        `@article{key${String(i)}, author={A. Author}, title={Title ${String(i)}}, year={2024}}`,
    ).join('\n')
    index.setFile('refs.bib', bib)
    const start = performance.now()
    expect(index.citations()).toHaveLength(5000)
    expect(performance.now() - start).toBeLessThan(100)
  })
})

describe('editor settings', () => {
  it('only spellchecks prose files', () => {
    expect(isSpellcheckedPath('main.tex')).toBe(true)
    expect(isSpellcheckedPath('chapters/Intro.TEX')).toBe(true)
    expect(isSpellcheckedPath('notes.txt')).toBe(true)
    for (const path of ['refs.bib', 'style.sty', 'thesis.cls', 'my.cfg', 'Makefile', '.tex']) {
      expect(isSpellcheckedPath(path)).toBe(false)
    }
  })

  it('reconfigures only what changed', () => {
    const base = editorSettings({ fontSize: 14, keymap: 'default', wrap: true }, 'dark')
    expect(settingsChange(base, editorSettings({ fontSize: 14, wrap: true }, 'dark'))).toBeNull()
    expect(settingsChange(base, editorSettings({ fontSize: 16, wrap: true }, 'dark'))).toEqual({
      appearance: expect.objectContaining({ fontSize: 16 }) as unknown,
    })
    expect(
      settingsChange(base, editorSettings({ fontSize: 14, keymap: 'vim', wrap: false }, 'light')),
    ).toEqual({ theme: 'light', keymap: 'vim', lineWrapping: false })
  })

  it('picks fonts and values', () => {
    expect(fontChoice('fira-code')).toBe('fira-code')
    expect(fontChoice('Cascadia Code')).toBe('custom')
    expect(isValidCustomFont('Cascadia Code, "Fira Mono"')).toBe(true)
    expect(isValidCustomFont('x; background: url(evil)')).toBe(false)
    expect(nearest([1.2, 1.5, 2], 1.6)).toBe(1.5)
    expect(spellcheckErrorMessage(new Error('x'))).toContain('navigateur')
  })
})
