// @vitest-environment happy-dom
import { undo } from '@codemirror/commands'
import { EditorView } from '@codemirror/view'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { latexExtensions } from '../index.js'
import { marked, stateOf } from '../test-utils.js'
import { addPackage, createDefaultRegistry, defaultActions } from './defaults.js'
import { ACTION_MENUS, type ActionHost } from './registry.js'

// happy-dom ne gère qu'une plage de sélection DOM : le focus ferait relire à CodeMirror une
// sélection réduite. Le focus n'est pas ce qui est testé ici.
vi.spyOn(EditorView.prototype, 'focus').mockImplementation(() => undefined)

const views: EditorView[] = []
afterEach(() => {
  for (const view of views.splice(0)) view.destroy()
})

/** Éditeur réel (DOM happy-dom) avec l'historique local, sur un document marqué. */
function editor(doc: string, readOnly = false): EditorView {
  const state = stateOf(doc, latexExtensions({ readOnly, theme: 'light' }))
  const view = new EditorView({ state, parent: document.body })
  views.push(view)
  return view
}

const registry = createDefaultRegistry()

/** Applique une action et renvoie le document marqué. */
function apply(id: string, doc: string, host: ActionHost = {}): { view: EditorView; out: string } {
  const view = editor(doc)
  expect(registry.run(id, { view, host })).toBe(true)
  return { view, out: marked(view.state) }
}

describe('default actions', () => {
  it('fills every toolbar menu with French labels and unique ids', () => {
    for (const menu of ACTION_MENUS) expect(registry.byMenu(menu.id).length).toBeGreaterThan(0)
    expect(new Set(defaultActions.map((action) => action.id)).size).toBe(defaultActions.length)
    expect(registry.get('format.bold')).toMatchObject({ label: 'Gras', shortcut: 'Mod-b' })
  })

  it('wraps the selection in \\textbf and keeps it selected', () => {
    expect(apply('format.bold', 'a «word» b').out).toBe('a \\textbf{«word»} b')
  })

  it('inserts an empty command with the cursor inside when nothing is selected', () => {
    expect(apply('format.italic', 'a | b').out).toBe('a \\textit{|} b')
  })

  it('unwraps an already formatted selection (inside or around the braces)', () => {
    expect(apply('format.bold', 'a \\textbf{«word»} b').out).toBe('a «word» b')
    expect(apply('format.bold', 'a «\\textbf{word}» b').out).toBe('a «word» b')
  })

  it('wraps every range of a multiple selection', () => {
    expect(apply('format.code', '«a» and «b»').out).toBe('\\texttt{«a»} and \\texttt{«b»}')
  })

  it('is undone in a single step', () => {
    const { view } = apply('format.bold', 'a «word» b')
    undo(view)
    expect(marked(view.state)).toBe('a «word» b')
    const block = apply('structures.itemize', 'x\n«one\ntwo»\ny')
    undo(block.view)
    expect(block.view.state.doc.toString()).toBe('x\none\ntwo\ny')
  })

  it('wraps a font size in a group', () => {
    expect(apply('format.size.large', '«big»').out).toBe('{\\large «big»}')
  })

  it('puts a new section on its own line, or uses the selection as its title', () => {
    expect(apply('structures.section', 'Text|').out).toBe('Text\n\\section{|}')
    expect(apply('structures.subsection', '  |').out).toBe('  \\subsection{|}')
    expect(apply('structures.section', '«Intro»').out).toBe('\\section{«Intro»}')
  })

  it('inserts a list with an item, or turns selected lines into items', () => {
    expect(apply('structures.itemize', '|').out).toBe(
      '\\begin{itemize}\n  \\item |\n\\end{itemize}',
    )
    expect(apply('structures.enumerate', '«one\ntwo»').out).toBe(
      '\\begin{enumerate}\n  \\item «one\n  \\item two»\n\\end{enumerate}',
    )
  })

  it('keeps the indentation of the current line for blocks', () => {
    expect(apply('math.equation', '  |').out).toBe('  \\begin{equation}\n    |\n  \\end{equation}')
  })

  it('places two cursors in a custom environment name', () => {
    const { view, out } = apply('structures.environment', '|')
    expect(out).toBe('\\begin{|}\n\n\\end{|}')
    view.dispatch(view.state.replaceSelection('proof'))
    expect(view.state.doc.toString()).toBe('\\begin{proof}\n\n\\end{proof}')
  })

  it('inserts fractions and roots around the selection', () => {
    expect(apply('math.fraction', '|').out).toBe('\\frac{|}{}')
    expect(apply('math.fraction', '«a»').out).toBe('\\frac{a}{|}')
    expect(apply('math.root', '«x»').out).toBe('\\sqrt[|]{x}')
    expect(apply('math.inline', '«x^2»').out).toBe('\\(«x^2»\\)')
  })

  it('loads amsmath with align when the file has a preamble', () => {
    const doc = '\\documentclass{article}\n\\begin{document}\n|\n\\end{document}'
    const { view, out } = apply('math.align', doc)
    expect(out).toContain('\\documentclass{article}\n\\usepackage{amsmath}\n\\begin{document}')
    expect(out).toContain('\\begin{align}\n  | &= \\\\\n   &= \n\\end{align}')
    undo(view)
    expect(view.state.doc.toString()).toBe(doc.replace('|', ''))
    // Déjà chargé : pas de doublon.
    const twice = apply('math.align', out.replace(/\|/g, ''))
    expect(twice.out.match(/usepackage\{amsmath\}/g)).toHaveLength(1)
  })

  it('builds a figure from a selected image path and loads graphicx', () => {
    const doc = '\\documentclass{article}\n\\begin{document}\n«img/cat.png»\n\\end{document}'
    const { out } = apply('graphics.figure', doc)
    expect(out).toContain('\\usepackage{graphicx}')
    expect(out).toContain(
      '\\begin{figure}[htbp]\n  \\centering\n  \\includegraphics[width=0.8\\linewidth]{img/cat.png}\n  \\caption{|}\n  \\label{fig:}\n\\end{figure}',
    )
  })

  it('inserts \\usepackage{} in the preamble with the cursor on the name', () => {
    const { out } = apply(
      'packages.usepackage',
      '\\documentclass{article}\n\\usepackage{amsmath}\n\\begin{document}\nText|\n\\end{document}',
    )
    expect(out).toBe(
      '\\documentclass{article}\n\\usepackage{amsmath}\n\\usepackage{|}\n\\begin{document}\nText\n\\end{document}',
    )
  })

  it('warns instead of inserting \\usepackage in a file without preamble', () => {
    const notify = vi.fn()
    const view = editor('\\section{A}|')
    expect(registry.run('packages.usepackage', { view, host: { notify } })).toBe(false)
    expect(notify).toHaveBeenCalledWith(expect.stringContaining('préambule'), 'warning')
    expect(view.state.doc.toString()).toBe('\\section{A}')
  })

  it('disables edits when the editor is read-only, but still allows search', () => {
    const view = editor('a «b» c', true)
    const context = { view, host: {} }
    expect(registry.isEnabled('format.bold', context)).toBe(false)
    expect(registry.run('format.bold', context)).toBe(false)
    expect(view.state.doc.toString()).toBe('a b c')
    expect(registry.isEnabled('search.find', context)).toBe(true)
    expect(registry.isEnabled('replace.open', context)).toBe(false)
  })

  it('calls the application for file actions, only when it provides them', () => {
    const newFile = vi.fn()
    expect(registry.isEnabled('file.new-file', { view: null, host: {} })).toBe(false)
    expect(registry.run('file.new-file', { view: null, host: { newFile } })).toBe(true)
    expect(newFile).toHaveBeenCalledOnce()
    expect(
      registry.isEnabled('file.new-file', { view: null, host: { newFile, readOnly: true } }),
    ).toBe(false)
    expect(
      registry.isEnabled('file.download-zip', {
        view: null,
        host: { downloadZip: vi.fn(), readOnly: true },
      }),
    ).toBe(true)
  })

  it('opens a project search prefilled with the selected text', () => {
    const searchProject = vi.fn()
    const view = editor('see «lemma» here')
    expect(registry.run('search.project', { view, host: { searchProject } })).toBe(true)
    expect(searchProject).toHaveBeenCalledWith('lemma')
  })

  it('opens the search panel, and the replace field for replace.open', () => {
    const view = editor('abc')
    expect(registry.run('search.find', { view, host: {} })).toBe(true)
    expect(view.dom.querySelector('.cm-search')).not.toBeNull()
    expect(registry.run('replace.open', { view, host: {} })).toBe(true)
    expect(document.activeElement?.getAttribute('name')).toBe('replace')
  })
})

describe('addPackage', () => {
  it('reports the plan status and adds options to an existing package', () => {
    const view = editor(
      '\\documentclass{article}\n\\usepackage{geometry}\n\\begin{document}\n\\end{document}',
    )
    expect(addPackage(view, 'geometry', ['margin=2cm'])).toBe('update')
    expect(view.state.doc.toString()).toContain('\\usepackage[margin=2cm]{geometry}')
    expect(addPackage(view, 'geometry', ['margin=2cm'])).toBe('present')
  })
})
