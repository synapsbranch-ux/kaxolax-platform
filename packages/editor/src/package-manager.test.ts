// @vitest-environment happy-dom
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { addPackage, createDefaultRegistry, latexExtensions } from './index.js'
import {
  planPackageOptions,
  planRemovePackage,
  projectPackages,
  removePackage,
  setPackageOptions,
} from './package-manager.js'

function remove(doc: string, name: string): string {
  const plan = planRemovePackage(doc, name)
  if (plan.status !== 'remove') return doc
  let out = doc
  for (const change of [...plan.changes].reverse()) {
    out = out.slice(0, change.from) + change.insert + out.slice(change.to)
  }
  return out
}

const doc = `\\documentclass{article}
\\usepackage[utf8]{inputenc}
\\usepackage[T1]{fontenc} \\usepackage{lmodern} % polices
\\usepackage{amsmath, amssymb,amsthm}
\\usepackage[
  margin=2cm,
  top=3cm
]{geometry}
\\usepackage{%
  graphicx,
  xcolor
}
% \\usepackage{tikz}
\\usepackage[colorlinks]{hyperref} % liens
\\begin{document}
\\usepackage{late}
Texte.
\\end{document}`

describe('projectPackages', () => {
  it('lists every package with its options, several per line or per command', () => {
    expect(
      projectPackages(doc).map((pkg) => [pkg.name, pkg.options, pkg.shared, pkg.line]),
    ).toEqual([
      ['inputenc', ['utf8'], false, 2],
      ['fontenc', ['T1'], false, 3],
      ['lmodern', [], false, 3],
      ['amsmath', [], true, 4],
      ['amssymb', [], true, 4],
      ['amsthm', [], true, 4],
      ['geometry', ['margin=2cm', 'top=3cm'], false, 5],
      ['graphicx', [], true, 9],
      ['xcolor', [], true, 9],
      ['hyperref', ['colorlinks'], false, 14],
    ])
    expect(projectPackages('\\section{x}')).toEqual([])
  })
})

describe('planRemovePackage', () => {
  it('removes a lone package with its options and its whole line (comment included)', () => {
    expect(remove(doc, 'inputenc')).not.toContain('inputenc')
    expect(remove(doc, 'inputenc').split('\n')[1]).toBe(
      '\\usepackage[T1]{fontenc} \\usepackage{lmodern} % polices',
    )
    const withoutHyperref = remove(doc, 'hyperref')
    expect(withoutHyperref).toContain('% \\usepackage{tikz}\n\\begin{document}')
    const withoutGeometry = remove(doc, 'geometry')
    expect(withoutGeometry).toContain('amsthm}\n\\usepackage{%')
    expect(withoutGeometry).not.toContain('margin')
  })

  it('keeps the other commands of a shared line', () => {
    expect(remove(doc, 'fontenc').split('\n')[2]).toBe('\\usepackage{lmodern} % polices')
    expect(remove(doc, 'lmodern').split('\n')[2]).toBe('\\usepackage[T1]{fontenc} % polices')
  })

  it('removes one name from a list, keeping its layout', () => {
    expect(remove(doc, 'amsmath').split('\n')[3]).toBe('\\usepackage{amssymb,amsthm}')
    expect(remove(doc, 'amssymb').split('\n')[3]).toBe('\\usepackage{amsmath,amsthm}')
    expect(remove(doc, 'amsthm').split('\n')[3]).toBe('\\usepackage{amsmath, amssymb}')
    expect(remove(doc, 'xcolor')).toContain('\\usepackage{%\n  graphicx\n}')
    expect(remove(doc, 'graphicx')).toContain('\\usepackage{%\n  xcolor\n}')
    expect(remove(remove(doc, 'graphicx'), 'xcolor')).not.toContain('\\usepackage{%')
  })

  it('removes every command loading the package, and reports shared options', () => {
    const twice =
      '\\documentclass{article}\n\\usepackage{tikz}\n\\usepackage[x]{a,tikz}\n\\usepackage{tikz}'
    expect(remove(twice, 'tikz')).toBe('\\documentclass{article}\n\\usepackage[x]{a}')
    expect(planRemovePackage(twice, 'tikz')).toMatchObject({ sharedOptions: true })
    expect(planRemovePackage(twice, 'none').status).toBe('absent')
    expect(planRemovePackage('\\section{x}', 'tikz').status).toBe('no-preamble')
    // Package après \begin{document} : pas dans le préambule.
    expect(planRemovePackage(doc, 'late').status).toBe('absent')
  })
})

describe('package options', () => {
  it('replaces, adds and removes the options of a lone package', () => {
    const apply = (source: string, name: string, options: string[]) => {
      const plan = planPackageOptions(source, name, options)
      if (plan.status !== 'update') return plan.status
      const { from, to, insert } = plan.change
      return source.slice(0, from) + insert + source.slice(to)
    }
    expect(apply(doc, 'hyperref', ['hidelinks'])).toContain('\\usepackage[hidelinks]{hyperref}')
    expect(apply(doc, 'lmodern', ['x', ' '])).toContain('\\usepackage[x]{lmodern}')
    expect(apply(doc, 'inputenc', [])).toContain('\\usepackage{inputenc}')
    expect(apply(doc, 'inputenc', ['utf8'])).toBe('unchanged')
    expect(apply(doc, 'amsmath', ['x'])).toBe('shared')
    expect(apply(doc, 'tikz', ['x'])).toBe('absent')
  })

  it('targets the chosen command of a package loaded twice', () => {
    const source =
      '\\documentclass{article}\n\\usepackage{a,b}\n\\usepackage[x]{a}\n\\usepackage{c}\n\\usepackage{c}\n'
    const [shared, lone, firstC, secondC] = projectPackages(source).filter(
      (entry) => entry.name !== 'b',
    )
    const apply = (name: string, at: number | undefined) => {
      const plan = planPackageOptions(source, name, ['y'], at)
      if (plan.status !== 'update') return plan.status
      const { from, to, insert } = plan.change
      return source.slice(0, from) + insert + source.slice(to)
    }
    expect(apply('a', shared?.from)).toBe('shared')
    expect(apply('a', lone?.from)).toContain('\\usepackage{a,b}\n\\usepackage[y]{a}')
    expect(apply('c', secondC?.from)).toContain('\\usepackage{c}\n\\usepackage[y]{c}\n')
    expect(apply('c', firstC?.from)).toContain('\\usepackage[y]{c}\n\\usepackage{c}\n')
    // Position périmée : plusieurs commandes possibles, rien n'est modifié.
    expect(apply('c', 0)).toBe('absent')
    expect(apply('a', 0)).toBe('absent')
  })
})

describe('editor commands', () => {
  const views: EditorView[] = []
  afterEach(() => {
    for (const view of views.splice(0)) view.destroy()
  })
  function editor(text: string, readOnly = false): EditorView {
    const view = new EditorView({
      state: EditorState.create({ doc: text, extensions: latexExtensions({ readOnly }) }),
      parent: document.body,
    })
    views.push(view)
    return view
  }

  it('adds with options, changes options and removes in one undo step each', () => {
    const view = editor('\\documentclass{article}\n\\begin{document}\n\\end{document}')
    expect(addPackage(view, 'geometry', ['margin=2cm'])).toBe('insert')
    expect(setPackageOptions(view, 'geometry', ['margin=1in', 'landscape'])).toBe('update')
    expect(view.state.doc.line(2).text).toBe('\\usepackage[margin=1in,landscape]{geometry}')
    expect(removePackage(view, 'geometry')).toBe('remove')
    expect(view.state.doc.toString()).toBe(
      '\\documentclass{article}\n\\begin{document}\n\\end{document}',
    )
  })

  it('does not modify a read-only document', () => {
    const view = editor('\\documentclass{article}\n\\usepackage{tikz}', true)
    expect(removePackage(view, 'tikz')).toBe('remove')
    expect(view.state.doc.toString()).toContain('tikz')
  })

  it('opens the package manager dialog with the packages of the current file', () => {
    const registry = createDefaultRegistry()
    const openDialog = vi.fn()
    const view = editor('\\documentclass{article}\n\\usepackage[a]{b,c}')
    expect(registry.run('packages.manager', { view, host: { openDialog } })).toBe(true)
    expect(openDialog).toHaveBeenCalledWith('packages.manager', {
      kind: 'packages',
      packages: [
        expect.objectContaining({ name: 'b', options: ['a'], shared: true }),
        expect.objectContaining({ name: 'c', options: ['a'], shared: true }),
      ],
      hasPreamble: true,
      readOnly: false,
    })
    expect(registry.isEnabled('packages.manager', { view, host: {} })).toBe(false)
  })
})
