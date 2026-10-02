// @vitest-environment happy-dom
import { undo } from '@codemirror/commands'
import { EditorView } from '@codemirror/view'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { latexExtensions } from '../index.js'
import { marked, stateOf } from '../test-utils.js'
import { insertFromTool, insertSymbol } from '../writing/apply.js'
import { symbolById } from '../writing/symbols.js'
import { generateTable } from '../writing/table-latex.js'
import { createTable, setCellContent } from '../writing/table-model.js'
import { createDefaultRegistry } from './defaults.js'
import type { ActionHost } from './registry.js'
import {
  applyFormula,
  applyTable,
  compactLatex,
  formulaInsertion,
  type FormulaDialogPayload,
  type TableDialogPayload,
  WRITING_DIALOGS,
} from './writing.js'

vi.spyOn(EditorView.prototype, 'focus').mockImplementation(() => undefined)

const views: EditorView[] = []
afterEach(() => {
  for (const view of views.splice(0)) view.destroy()
})

function editor(doc: string, readOnly = false): EditorView {
  const view = new EditorView({
    state: stateOf(doc, latexExtensions({ readOnly, theme: 'light' })),
    parent: document.body,
  })
  views.push(view)
  return view
}

const registry = createDefaultRegistry()

/** Ouvre l'outil `id` et renvoie la boîte de dialogue demandée. */
function open(id: string, view: EditorView): { dialog: string; payload: unknown } {
  const opened: { dialog: string; payload: unknown }[] = []
  const host: ActionHost = {
    openDialog: (dialog, payload) => {
      opened.push({ dialog, payload })
    },
  }
  expect(registry.run(id, { view, host })).toBe(true)
  const first = opened[0]
  if (!first) throw new Error('no dialog')
  return first
}

const DOC = '\\documentclass{article}\n\\usepackage{amsmath}\n\\begin{document}\n'

describe('writing actions', () => {
  it('are registered in the Math and Structures menus', () => {
    expect(
      registry
        .byMenu('math')
        .slice(0, 2)
        .map((action) => action.id),
    ).toEqual([WRITING_DIALOGS.formula, WRITING_DIALOGS.symbols])
    expect(registry.get(WRITING_DIALOGS.formula)).toMatchObject({
      label: 'Éditeur de formules',
      shortcut: 'Mod-Shift-e',
    })
    expect(registry.byMenu('structures').map((action) => action.id)).toContain('structures.table')
    expect(registry.get('structures.table')?.label).toBe('Tableau')
  })

  it('are disabled without a dialog host or in read-only mode', () => {
    const view = editor('x')
    expect(registry.isEnabled(WRITING_DIALOGS.formula, { view, host: {} })).toBe(false)
    const host: ActionHost = { openDialog: () => undefined }
    expect(registry.isEnabled(WRITING_DIALOGS.formula, { view, host })).toBe(true)
    expect(registry.isEnabled(WRITING_DIALOGS.table, { view: null, host })).toBe(false)
    expect(registry.isEnabled(WRITING_DIALOGS.symbols, { view: editor('x', true), host })).toBe(
      false,
    )
    expect(
      registry.isEnabled(WRITING_DIALOGS.symbols, { view, host: { ...host, readOnly: true } }),
    ).toBe(false)
  })
})

describe('formula editor', () => {
  it('opens with the formula under the cursor and replaces exactly its range', () => {
    const view = editor(`${DOC}See \\begin{align*}\n  a &|= b \\\\\n  c &= d\n\\end{align*} here`)
    const { dialog, payload } = open(WRITING_DIALOGS.formula, view)
    expect(dialog).toBe('math.formula')
    const formula = payload as FormulaDialogPayload
    expect(formula).toMatchObject({
      kind: 'formula',
      style: 'display',
      wrapper: 'aligned',
      initial: '\\begin{aligned}a &= b \\\\\n  c &= d\\end{aligned}',
    })
    // Aller-retour sans modification : rien n'est écrit.
    expect(applyFormula(view, formula, { latex: formula.initial, style: 'display' })).toBe(
      'unchanged',
    )
    const status = applyFormula(view, formula, {
      latex: '\\begin{aligned}a&=b+\\exponentialE\\\\c&=d\\end{aligned}',
      style: 'display',
    })
    expect(status).toBe('replaced')
    expect(view.state.doc.toString()).toBe(
      // Une ligne par `\\\\`, avec l'indentation d'origine (MathLive rend tout sur une ligne).
      `${DOC}See \\begin{align*}\n  a&=b+e\\\\\n  c&=d\n\\end{align*} here`,
    )
    undo(view)
    expect(view.state.doc.toString()).toContain('a &= b \\\\\n  c &= d')
  })

  it('keeps the original text of a formula that MathLive only respaced', () => {
    const view = editor(
      `${DOC}\\begin{equation}\n\t\\label{eq:a}\n\t\\alpha  x  +  y|\n\\end{equation}`,
    )
    const formula = open(WRITING_DIALOGS.formula, view).payload as FormulaDialogPayload
    expect(formula.label).toBe('eq:a')
    const latex = '\\alpha x+y'
    expect(applyFormula(view, formula, { latex, style: 'equation', label: 'eq:a' })).toBe(
      'unchanged',
    )
    expect(applyFormula(view, formula, { latex, style: 'equation', label: 'eq:b' })).toBe(
      'replaced',
    )
    expect(view.state.doc.toString()).toBe(
      `${DOC}\\begin{equation}\n\t\\label{eq:b}\n\t\\alpha  x  +  y\n\\end{equation}`,
    )
    const next = open(WRITING_DIALOGS.formula, view).payload as FormulaDialogPayload
    applyFormula(view, next, { latex: '\\alpha x-y', style: 'equation', label: 'eq:b' })
    expect(view.state.doc.toString()).toContain('\\label{eq:b}\n\t\\alpha x-y\n')
  })

  it('inserts a new numbered equation on its own lines with its packages', () => {
    const view = editor('\\documentclass{article}\n\\begin{document}\n  Text| more\n')
    const formula = open(WRITING_DIALOGS.formula, view).payload as FormulaDialogPayload
    expect(formula).toMatchObject({ formula: null, target: null, style: 'inline' })
    applyFormula(view, formula, {
      latex: '\\begin{pmatrix}1\\\\2\\end{pmatrix}',
      style: 'equation',
      label: 'eq:m',
    })
    expect(marked(view.state)).toBe(
      [
        '\\documentclass{article}',
        '\\usepackage{amsmath}',
        '\\begin{document}',
        '  Text',
        '  \\begin{equation}',
        '    \\label{eq:m}',
        '    \\begin{pmatrix}1\\\\2\\end{pmatrix}',
        '  \\end{equation}|',
        '  more',
        '',
      ].join('\n'),
    )
    undo(view)
    expect(view.state.doc.toString()).toBe(
      '\\documentclass{article}\n\\begin{document}\n  Text more\n',
    )
  })

  it('turns the selection into an inline formula', () => {
    const view = editor(`${DOC}area «x^2» end`)
    const formula = open(WRITING_DIALOGS.formula, view).payload as FormulaDialogPayload
    expect(formula.initial).toBe('x^2')
    applyFormula(view, formula, { latex: 'x^{2}', style: 'inline' })
    expect(marked(view.state)).toBe(`${DOC}area \\(x^{2}\\)| end`)
  })

  it('does nothing when the formula disappeared meanwhile', () => {
    const view = editor(`${DOC}$a|$`)
    const formula = open(WRITING_DIALOGS.formula, view).payload as FormulaDialogPayload
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: 'gone' } })
    expect(applyFormula(view, formula, { latex: 'b', style: 'inline' })).toBe('stale')
    expect(view.state.doc.toString()).toBe('gone')
  })

  it('finds the formula again after edits above it', () => {
    const view = editor(`${DOC}$a|$`)
    const formula = open(WRITING_DIALOGS.formula, view).payload as FormulaDialogPayload
    view.dispatch({ changes: { from: DOC.length, insert: 'New text ' } })
    applyFormula(view, formula, { latex: 'b', style: 'inline' })
    expect(view.state.doc.toString()).toBe(`${DOC}New text $b$`)
  })
})

describe('symbol picker', () => {
  const leqslant = symbolById('\\leqslant')
  const euro = symbolById('\\texteuro')
  if (!leqslant || !euro) throw new Error('symbols expected')

  it('tells whether the cursor is in math mode', () => {
    expect(open(WRITING_DIALOGS.symbols, editor('$x|$')).payload).toEqual({
      kind: 'symbols',
      math: true,
    })
    expect(open(WRITING_DIALOGS.symbols, editor('x|')).payload).toEqual({
      kind: 'symbols',
      math: false,
    })
  })

  it('inserts a symbol and optionally its package in one undo step', () => {
    const view = editor(`${DOC}$a |b$`)
    expect(insertSymbol(view, leqslant, { addPackages: true })).toBe(true)
    expect(marked(view.state)).toBe(
      `\\documentclass{article}\n\\usepackage{amsmath}\n\\usepackage{amssymb}\n\\begin{document}\n$a \\leqslant |b$`,
    )
    undo(view)
    expect(view.state.doc.toString()).toBe(`${DOC}$a b$`)
    const plain = editor('price |')
    insertSymbol(plain, euro)
    expect(marked(plain.state)).toBe('price \\texteuro|')
    const math = editor('$x|$')
    insertSymbol(math, leqslant)
    expect(marked(math.state)).toBe('$x\\leqslant|$')
  })
})

describe('table generator', () => {
  const table = [
    '\\begin{table}[htbp]',
    '\t\\centering',
    '\t\\begin{tabular}{ll}',
    '\t\t\\toprule',
    '\t\ta & b \\\\',
    '\t\t\\bottomrule',
    '\t\\end{tabular}',
    '\\end{table}',
  ].join('\n')

  it('opens with the table under the cursor and replaces it exactly', () => {
    const doc = `\\documentclass{article}\n\\usepackage{booktabs}\n\\begin{document}\nText\n${table}\nEnd`
    const view = editor(doc.replace('a & b', 'a |& b'))
    const payload = open(WRITING_DIALOGS.table, view).payload as TableDialogPayload
    expect(payload.scope).toBe('float')
    expect(payload.target?.text).toBe(table)
    if (payload.parse?.ok !== true) throw new Error('table expected')
    expect(applyTable(view, payload, payload.parse.model)).toBe('unchanged')
    const edited = setCellContent(payload.parse.model, 0, 1, '$x_1$')
    expect(applyTable(view, payload, edited)).toBe('replaced')
    // Texte régénéré à l'indentation de l'éditeur (deux espaces par niveau ici).
    expect(view.state.doc.toString()).toBe(doc.replace('a & b', 'a & $x_1$').replace(/\t/g, '  '))
    undo(view)
    expect(view.state.doc.toString()).toBe(doc)
  })

  it('inserts a new table at the cursor indentation and adds packages', () => {
    const view = editor('\\documentclass{article}\n\\begin{document}\n  |\n')
    const payload = open(WRITING_DIALOGS.table, view).payload as TableDialogPayload
    expect(payload).toEqual({
      kind: 'table',
      target: null,
      nested: false,
      parse: null,
      selection: '',
    })
    const model = createTable([['a', 'b']])
    expect(applyTable(view, payload, model)).toBe('inserted')
    const indented = generateTable(model)
      .text.split('\n')
      .map((line) => `  ${line.replace(/\t/g, '  ')}`)
      .join('\n')
    expect(view.state.doc.toString()).toBe(
      `\\documentclass{article}\n\\usepackage{booktabs}\n\\begin{document}\n${indented}\n`,
    )
  })

  it('replaces a table kept as raw text', () => {
    const source = '\\begin{tabular}{l} a & b \\\\ \\end{tabular}'
    const view = editor(`x ${source.replace('a', '|a')} y`)
    const payload = open(WRITING_DIALOGS.table, view).payload as TableDialogPayload
    expect(payload.parse?.ok).toBe(false)
    applyTable(view, payload, { raw: '\\begin{tabular}{ll} a & b \\\\ \\end{tabular}' })
    expect(view.state.doc.toString()).toBe('x \\begin{tabular}{ll} a & b \\\\ \\end{tabular} y')
  })

  it('offers the selection as pasted data', () => {
    const view = editor('«a,b\n1,2»')
    expect((open(WRITING_DIALOGS.table, view).payload as TableDialogPayload).selection).toBe(
      'a,b\n1,2',
    )
  })

  it('refuses to write in read-only mode', () => {
    expect(insertFromTool(editor('x', true), null, 'y', { block: false })).toBe('read-only')
  })
})

describe('round trips (review fixes)', () => {
  const alpha = symbolById('\\alpha')
  const euro = symbolById('\\texteuro')
  if (!alpha || !euro) throw new Error('symbols expected')

  it('wraps a math symbol next to the delimiters of a displayed formula', () => {
    const after = editor('Text\n\\begin{equation}\nx\n\\end{equation}|\nmore')
    expect(open(WRITING_DIALOGS.symbols, after).payload).toEqual({ kind: 'symbols', math: false })
    insertSymbol(after, alpha)
    expect(marked(after.state)).toBe(
      'Text\n\\begin{equation}\nx\n\\end{equation}\\(\\alpha\\)|\nmore',
    )
    const before = editor('Text\n|\\begin{equation}\nx\n\\end{equation}')
    insertSymbol(before, alpha)
    expect(before.state.doc.toString()).toContain('\\(\\alpha\\)\\begin{equation}')
    // Dans `\text{…}` d'une formule : mode texte.
    const text = editor('$\\text{a |b}$')
    insertSymbol(text, alpha)
    expect(text.state.doc.toString()).toBe('$\\text{a \\(\\alpha\\)b}$')
    const inside = editor('$\\text{a} |b$')
    insertSymbol(inside, euro)
    expect(inside.state.doc.toString()).toBe('$\\text{a} \\text{\\texteuro}b$')
  })

  it('keeps a replaced selection apart from the next letter', () => {
    const view = editor('$«x»y$')
    insertSymbol(view, alpha)
    expect(marked(view.state)).toBe('$\\alpha |y$')
  })

  it('never replaces another identical formula changed by a collaborator', () => {
    const view = editor(`${DOC}A $|x$.\n\nB $x$.`)
    const formula = open(WRITING_DIALOGS.formula, view).payload as FormulaDialogPayload
    // Un collaborateur modifie la formule ouverte (x → x+1).
    const at = view.state.doc.toString().indexOf('$x$') + 2
    view.dispatch({ changes: { from: at, insert: '+1' } })
    expect(applyFormula(view, formula, { latex: 'y', style: 'inline' })).toBe('stale')
    expect(view.state.doc.toString()).toBe(`${DOC}A $x+1$.\n\nB $x$.`)
  })

  it('keeps the rest of a formula after a comment', () => {
    const view = editor(`${DOC}\\begin{equation}\n  a = b| % premier terme\n  + c\n\\end{equation}`)
    const formula = open(WRITING_DIALOGS.formula, view).payload as FormulaDialogPayload
    applyFormula(view, formula, {
      latex: formula.initial.replace('b', 'B'),
      style: 'equation',
    })
    expect(view.state.doc.toString()).toBe(
      `${DOC}\\begin{equation}\n  a = B % premier terme\n  + c\n\\end{equation}`,
    )
    const inline = editor('Soit \\(a % note\n + b|\\) ici.')
    const payload = open(WRITING_DIALOGS.formula, inline).payload as FormulaDialogPayload
    applyFormula(inline, payload, { latex: payload.initial.replace('b', 'c'), style: 'inline' })
    expect(inline.state.doc.toString()).toBe('Soit \\(a % note\n + c\\) ici.')
    // Commentaire en dernière ligne : le délimiteur passe à la ligne suivante.
    const last = editor('Soit $|a$ ici.')
    const end = open(WRITING_DIALOGS.formula, last).payload as FormulaDialogPayload
    applyFormula(last, end, { latex: 'a % note', style: 'inline' })
    expect(last.state.doc.toString()).toBe('Soit $a % note\n$ ici.')
  })

  it('keeps one row per line in a multi-line environment edited visually', () => {
    const view = editor(
      `${DOC}\\begin{align}\n  a &= b| \\nonumber \\\\\n  c &= d \\label{eq:c}\n\\end{align}`,
    )
    const formula = open(WRITING_DIALOGS.formula, view).payload as FormulaDialogPayload
    applyFormula(view, formula, {
      latex: '\\begin{aligned}a&=B\\nonumber\\\\c&=d\\label{eq:c}\\end{aligned}',
      style: 'equation',
    })
    expect(view.state.doc.toString()).toBe(
      `${DOC}\\begin{align}\n  a&=B\\nonumber\\\\\n  c&=d\\label{eq:c}\n\\end{align}`,
    )
  })

  it('sees a change of spaces in text groups', () => {
    const view = editor('$\\text{a |b}$')
    const formula = open(WRITING_DIALOGS.formula, view).payload as FormulaDialogPayload
    expect(applyFormula(view, formula, { latex: '\\text{ab}', style: 'inline' })).toBe('replaced')
    expect(view.state.doc.toString()).toBe('$\\text{ab}$')
    expect(compactLatex('\\text{a  b} + x')).toBe('\\text{a b}+x')
    expect(compactLatex('a % note\n+ b')).toBe('a+b')
  })

  it('does not nest a float in the float around a lone tabular', () => {
    const doc =
      '\\begin{table}\n\\small\n\\begin{tabular}{l}\nx| \\\\\n\\end{tabular}\n\\end{table}'
    const view = editor(doc)
    const payload = open(WRITING_DIALOGS.table, view).payload as TableDialogPayload
    expect(payload).toMatchObject({ scope: 'tabular', nested: true })
    if (payload.parse?.ok !== true) throw new Error('table expected')
    const model = setCellContent(payload.parse.model, 0, 0, 'y')
    model.float = { environment: 'table', placement: 'htbp', centering: true }
    applyTable(view, payload, model)
    const text = view.state.doc.toString()
    expect(text.match(/\\begin\{table\}/g)).toHaveLength(1)
    expect(text).toContain('y \\\\')
  })
})

describe('review fixes (round 2)', () => {
  it('refuses raw LaTeX that would not compile', () => {
    const view = editor(`${DOC}Texte |ici.`)
    const payload = open(WRITING_DIALOGS.formula, view).payload as FormulaDialogPayload
    const errors = (latex: string, style: 'inline' | 'display' | 'equation' = 'inline') =>
      formulaInsertion(payload, { latex, style }).errors
    expect(errors('\\frac{1}{2')).toEqual(['accolade non fermée'])
    expect(errors('a $ b')).toHaveLength(1)
    expect(errors('a & b', 'equation')).toHaveLength(1)
    expect(errors('\\[ x \\]', 'inline')).toHaveLength(2)
    expect(errors('\\end{equation} x', 'equation')).toHaveLength(1)
    expect(errors('\\begin{align} x \\end{align}', 'display')).toHaveLength(1)
    expect(errors('a # b')).toHaveLength(1)
    expect(errors('x}')).toEqual(['accolade fermante en trop'])
    // Commandes de MathLive sans équivalent LaTeX : refusées ; `\\href` demande hyperref.
    expect(errors('\\unicode{"2A00} x')).toHaveLength(1)
    expect(errors('\\ensuremath{x}')).toEqual([])
    expect(formulaInsertion(payload, { latex: '\\href{u}{x}', style: 'inline' }).packages).toEqual([
      'hyperref',
    ])
    // LaTeX valide : `&` dans aligned, `$` dans \text, `\$`, `\{`, accolades équilibrées.
    expect(errors('a &= b \\\\ c &= d', 'display')).toEqual([])
    expect(errors('\\begin{pmatrix}1 & 2\\end{pmatrix}')).toEqual([])
    expect(errors('\\text{si $x>0$} \\$ \\{a\\} \\& b % } commentaire')).toEqual([])
    expect(applyFormula(view, payload, { latex: '\\frac{1}{2', style: 'inline' })).toBe('invalid')
    expect(view.state.doc.toString()).toBe(`${DOC}Texte ici.`)
  })

  it('warns when a numbered equation loses its label', () => {
    const view = editor(`${DOC}\\begin{equation}\\label{eq:a} E=mc|^2 \\end{equation}`)
    const payload = open(WRITING_DIALOGS.formula, view).payload as FormulaDialogPayload
    const inline = formulaInsertion(payload, { latex: 'E=mc^3', style: 'inline' })
    expect(inline.text).toBe('\\(E=mc^3\\)')
    expect(inline.warnings.join(' ')).toContain('eq:a')
    expect(
      formulaInsertion(payload, { latex: 'E=mc^3', style: 'equation', label: 'eq:a' }).warnings,
    ).toEqual([])
  })

  it('adds only the packages that no loaded package provides', () => {
    const doc =
      '\\documentclass{article}\n\\usepackage{mathtools}\n\\usepackage{amssymb}\n\\begin{document}\n'
    const view = editor(`${doc}|`)
    const payload = open(WRITING_DIALOGS.formula, view).payload as FormulaDialogPayload
    applyFormula(view, payload, { latex: '\\mathbb{R}\\text{ et }\\mathscr{A}', style: 'inline' })
    const text = view.state.doc.toString()
    expect(text).not.toContain('\\usepackage{amsfonts}')
    expect(text).not.toContain('\\usepackage{amsmath}')
    expect(text).toContain('\\usepackage{mathrsfs}')
    // Symbole texte dans une formule : `\\text` (amsmath), déjà chargé par mathtools.
    const euro = symbolById('\\texteuro')
    if (!euro) throw new Error('symbol expected')
    const math = editor(`${doc}$x|$`)
    insertSymbol(math, euro, { addPackages: true })
    expect(math.state.doc.toString()).toContain('$x\\text{\\texteuro}$')
    expect(math.state.doc.toString()).not.toContain('\\usepackage{amsmath}')
  })

  it('inserts a new table without a float inside a figure or a minipage', () => {
    for (const env of ['figure', 'minipage', 'table']) {
      const args = env === 'minipage' ? '{5cm}' : ''
      const view = editor(`${DOC}\\begin{${env}}${args}\n|\n\\end{${env}}\n`)
      const payload = open(WRITING_DIALOGS.table, view).payload as TableDialogPayload
      expect(payload.nested).toBe(true)
      applyTable(view, payload, createTable([['a', 'b']]))
      const text = view.state.doc.toString()
      expect(text.match(/\\begin\{table\}/g)?.length ?? 0).toBe(env === 'table' ? 1 : 0)
      expect(text).toContain('\\begin{tabular}')
    }
    const top = editor(`${DOC}|\n`)
    expect((open(WRITING_DIALOGS.table, top).payload as TableDialogPayload).nested).toBe(false)
  })

  it('refuses a table whose caption would not compile', () => {
    const view = editor(`${DOC}|\n`)
    const payload = open(WRITING_DIALOGS.table, view).payload as TableDialogPayload
    const model = createTable([['a', 'b']])
    model.caption = 'Taux de 50% & co'
    expect(applyTable(view, payload, model)).toBe('invalid')
    expect(view.state.doc.toString()).toBe(`${DOC}\n`)
  })
})
