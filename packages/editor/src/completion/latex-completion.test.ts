// @vitest-environment happy-dom
import {
  type Completion,
  CompletionContext,
  type CompletionResult,
  currentCompletions,
  startCompletion,
} from '@codemirror/autocomplete'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { afterEach, describe, expect, it } from 'vitest'
import { latexExtensions } from '../index.js'
import { argumentContext, latexCompletionSource } from './latex-completion.js'
import { ProjectIndex } from './project-index.js'
import { scanTexFile } from './tex-scan.js'

/** Document avec `|` pour le curseur. */
function contextOf(marked: string, explicit = false): CompletionContext {
  const pos = marked.indexOf('|')
  const state = EditorState.create({ doc: marked.replace('|', '') })
  return new CompletionContext(state, pos, explicit)
}

function complete(
  marked: string,
  index: ProjectIndex | null = null,
  currentFile: string | null = null,
): CompletionResult | null {
  const source = latexCompletionSource({ sources: () => index, currentFile: () => currentFile })
  const result = source(contextOf(marked))
  if (result instanceof Promise) throw new Error('Synchronous source expected')
  return result
}

function labels(result: CompletionResult | null): string[] {
  return result?.options.map((option) => option.label) ?? []
}

function projectIndex(): ProjectIndex {
  const index = new ProjectIndex()
  index.setFiles([
    'main.tex',
    'chapters/intro.tex',
    'chapters/results.tex',
    'figures/plot.pdf',
    'figures/photo.JPG',
    'figures/notes.txt',
    'refs.bib',
  ])
  index.setFile(
    'main.tex',
    `\\documentclass{article}
\\usepackage{amsmath,cleveref}
\\newcommand{\\R}{\\mathbb{R}}
\\newcommand\\norm[1]{\\lVert #1\\rVert}
\\newtheorem{lemma}{Lemme}
\\begin{document}
\\section{Intro}\\label{sec:intro}
\\begin{equation}\\label{eq:main} x \\end{equation}
% \\label{commented}
\\end{document}`,
  )
  index.setFile('chapters/results.tex', '\\begin{figure}\\label{fig:plot}\\end{figure}')
  index.setFile(
    'refs.bib',
    `@article{knuth84, author = {Knuth, Donald}, title = {Literate Programming}, year = 1984}
@book{lamport94, author = {Leslie Lamport}, title = {{\\LaTeX}}, date = {1994-01}}`,
  )
  return index
}

describe('argument context', () => {
  it('finds the argument being typed, after the last comma of list commands', () => {
    const at = (marked: string) => {
      const context = contextOf(marked)
      return argumentContext(context.state, context.pos)
    }
    expect(at('\\cite{a, kn|')).toMatchObject({ command: 'cite', text: 'kn', from: 9 })
    expect(at('\\citep[see][p.~2]{|')).toMatchObject({ command: 'citep', text: '' })
    expect(at('\\ref{sec:in|')).toMatchObject({ command: 'ref', text: 'sec:in' })
    expect(at('\\section{Intro \\ref{fi|')).toMatchObject({ command: 'ref', text: 'fi' })
    expect(at('\\includegraphics[width=3cm]{fig|')).toMatchObject({ command: 'includegraphics' })
    expect(at('\\cite{a} text|')).toBeNull()
    expect(at('\\href{http://x}{te|')).toBeNull()
  })
})

describe('latexCompletionSource', () => {
  it('proposes base commands, and package commands only once the package is loaded', () => {
    const without = labels(complete('\\documentclass{article}\n\\begin{document}\n\\ci|'))
    expect(without).toContain('\\section')
    expect(without).toContain('\\cite')
    expect(without).not.toContain('\\citep')
    expect(without).not.toContain('\\cref')
    const doc = '\\documentclass{article}\n\\usepackage[numbers]{natbib}\n\\begin{document}\n\\ci|'
    const withNatbib = labels(complete(doc))
    expect(withNatbib).toContain('\\citep')
    expect(withNatbib).toContain('\\citet')
  })

  it('uses packages and definitions from the whole project index', () => {
    const result = complete('\\no|', projectIndex(), 'chapters/intro.tex')
    const options = labels(result)
    expect(options).toContain('\\cref') // cleveref chargé dans main.tex
    expect(options).toContain('\\eqref') // amsmath
    expect(options).toContain('\\norm') // \newcommand du projet
    expect(options).toContain('\\R')
    const norm = result?.options.find((option) => option.label === '\\norm')
    expect(norm?.detail).toBe('projet')
    expect(result?.from).toBe(0)
  })

  it('proposes environments, including those of loaded packages and of the project', () => {
    const doc = '\\documentclass{article}\n\\usepackage{amsmath}\n\\begin{document}\n\\begin{al|'
    const options = labels(complete(doc, projectIndex()))
    expect(options).toEqual(expect.arrayContaining(['itemize', 'align', 'align*', 'lemma']))
    expect(options).not.toContain('tikzpicture')
  })

  it('completes \\end{ with the innermost open environment first', () => {
    const result = complete('\\begin{itemize}\n\\begin{enumerate}\n\\item x\n\\end{|')
    const best = [...(result?.options ?? [])].sort((a, b) => (b.boost ?? 0) - (a.boost ?? 0))[0]
    expect(best?.label).toBe('enumerate')
    expect(best?.apply).toBe('enumerate}')
  })

  it('completes \\ref and its variants with the labels of every project file', () => {
    const index = projectIndex()
    for (const command of ['ref', 'eqref', 'autoref', 'cref', 'Cref', 'pageref']) {
      const result = complete(`\\${command}{|`, index)
      expect(labels(result)).toEqual(['sec:intro', 'eq:main', 'fig:plot'])
    }
    const equation = complete('\\eqref{|', index)?.options.find((o) => o.label === 'eq:main')
    expect(equation?.detail).toBe('equation · main.tex:8')
    expect(labels(complete('\\cref{sec:intro,|', index))).toContain('fig:plot')
  })

  it('completes \\cite and its variants with the keys of every .bib file', () => {
    const index = projectIndex()
    for (const command of ['cite', 'citep', 'citet', 'parencite', 'textcite', 'autocite']) {
      expect(labels(complete(`\\${command}{|`, index))).toEqual(['knuth84', 'lamport94'])
    }
    const knuth = complete('\\cite{|', index)?.options[0]
    expect(knuth).toMatchObject({ detail: 'Knuth 1984', info: 'Literate Programming' })
    const lamport = complete('\\cite{knuth84, l|', index)
    expect(lamport?.from).toBe('\\cite{knuth84, '.length)
    expect(lamport?.options[1]).toMatchObject({ detail: 'Lamport 1994', info: 'LaTeX' })
  })

  it('completes file paths with suitable extensions', () => {
    const index = projectIndex()
    expect(labels(complete('\\input{|', index, 'chapters/intro.tex'))).toEqual([
      'chapters/results',
      'main',
    ])
    expect(labels(complete('\\include{|', index, 'main.tex'))).toEqual([
      'chapters/intro',
      'chapters/results',
    ])
    expect(labels(complete('\\includegraphics[width=\\linewidth]{fig|', index))).toEqual([
      'figures/photo.JPG',
      'figures/plot.pdf',
    ])
    expect(labels(complete('\\bibliography{|', index))).toEqual(['refs'])
    expect(labels(complete('\\addbibresource{|', index))).toEqual(['refs.bib'])
  })

  it('makes file paths relative to the directory of the main document', () => {
    const index = new ProjectIndex()
    index.setFiles([
      'these/main.tex',
      'these/chapitres/intro.tex',
      'these/figures/a.png',
      'these/images/b.pdf',
      'commun/macros.tex',
      'logo.png',
    ])
    index.setRootDirectory('these')
    expect(labels(complete('\\input{|', index, 'these/main.tex'))).toEqual([
      'chapitres/intro',
      '../commun/macros',
    ])
    const graphics = complete('\\includegraphics{|', index)
    expect(labels(graphics)).toEqual(['figures/a.png', 'images/b.pdf', '../logo.png'])
    expect(graphics?.options.find((option) => option.label === '../logo.png')?.boost).toBe(-1)

    // Dossiers de \graphicspath : chemins relatifs à ces dossiers, proposés en premier.
    index.setFile(
      'these/main.tex',
      '\\documentclass{article}\n\\graphicspath{{figures/}{./images/}}\n\\begin{document}\\end{document}',
    )
    expect(labels(complete('\\includegraphics{|', index))).toEqual([
      'a.png',
      'b.pdf',
      'figures/a.png',
      'images/b.pdf',
      '../logo.png',
    ])
  })

  it('proposes package names after \\usepackage, including the TeX Live index', () => {
    const index = projectIndex()
    index.setPackageNames(['zztestpkg', 'tikz'])
    const options = labels(complete('\\usepackage[utf8]{inputenc,|', index))
    expect(options).toContain('zztestpkg')
    expect(options.filter((name) => name === 'tikz')).toHaveLength(1)
  })

  it('does not complete after a line break \\\\ or without a backslash', () => {
    expect(complete('a \\\\|')).toBeNull()
    expect(complete('plain text|')).toBeNull()
  })

  it('answers \\cite{ on 5,000 keys in less than 100 ms', { retry: 2 }, () => {
    const index = new ProjectIndex()
    const bib = Array.from(
      { length: 5000 },
      (_, i) =>
        `@article{key${String(i)}, author = {Author, A${String(i)} and Other, B}, title = {Title ${String(i)}}, year = {${String(1950 + (i % 70))}}}`,
    ).join('\n')
    index.setFiles(['main.tex', 'refs.bib'])
    index.setFile('refs.bib', bib)
    const source = latexCompletionSource({ sources: index })
    const state = EditorState.create({ doc: 'Voir \\cite{' })
    // Premier appel : construit la liste (une fois par version de l'index).
    let start = performance.now()
    const first = source(new CompletionContext(state, state.doc.length, false))
    const firstMs = performance.now() - start
    expect((first as CompletionResult).options).toHaveLength(5000)
    expect(firstMs).toBeLessThan(100)
    // Appels suivants (frappe) : liste en cache.
    start = performance.now()
    const second = source(new CompletionContext(state, state.doc.length, false))
    expect(performance.now() - start).toBeLessThan(10)
    expect((second as CompletionResult).options).toBe((first as CompletionResult).options)
  })
})

describe('autocompletion in the editor', () => {
  const views: EditorView[] = []
  afterEach(() => {
    for (const view of views.splice(0)) view.destroy()
  })

  // Le budget de 100 ms est vérifié sur la source de complétion (test précédent) ; ici, la vue
  // CodeMirror affiche bien les clés, dans le bon ordre. Mesurer le temps de bout en bout avec un
  // DOM simulé et une boucle d'attente dépend trop de la charge de la machine (CI).
  it('shows \\cite keys in the editor on 5,000 keys', async () => {
    const index = new ProjectIndex()
    index.setFiles(['refs.bib'])
    index.setFile(
      'refs.bib',
      Array.from({ length: 5000 }, (_, i) => `@misc{ref${String(i)}, title={T}}`).join('\n'),
    )
    const doc = 'Voir \\cite{ref49'
    const view = new EditorView({
      state: EditorState.create({
        doc,
        selection: { anchor: doc.length },
        extensions: latexExtensions({ completion: { sources: () => index } }),
      }),
      parent: document.body,
    })
    views.push(view)
    const start = performance.now()
    startCompletion(view)
    let completions: readonly Completion[] = []
    while (completions.length === 0 && performance.now() - start < 1000) {
      await new Promise((resolve) => setTimeout(resolve, 1))
      completions = currentCompletions(view.state)
    }
    expect(completions[0]?.label).toBe('ref49')
    // Correspondances par préfixe en tête : ref49, puis ref490 à ref499.
    expect(completions.slice(0, 11).every((option) => option.label.startsWith('ref49'))).toBe(true)
  })

  it('inserts an environment with its \\end, or only the name inside existing braces', () => {
    const doc = '\\begin{item'
    const view = new EditorView({
      state: EditorState.create({
        doc,
        selection: { anchor: doc.length },
        extensions: latexExtensions(),
      }),
      parent: document.body,
    })
    views.push(view)
    const source = latexCompletionSource()
    const result = source(new CompletionContext(view.state, doc.length, true)) as CompletionResult
    const itemize = result.options.find((option) => option.label === 'itemize')
    if (!itemize || typeof itemize.apply !== 'function') throw new Error('itemize expected')
    itemize.apply(view, itemize, result.from, doc.length)
    expect(view.state.doc.toString()).toBe('\\begin{itemize}\n  \\item \n\\end{itemize}')
  })
})

describe('scanTexFile', () => {
  it('collects labels with context, definitions and packages, ignoring comments and verbatim', () => {
    const scan = scanTexFile(`\\documentclass[a4paper]{report}
\\usepackage[french]{babel}\\usepackage{tikz}
\\DeclareMathOperator{\\argmax}{arg\\,max}
\\def\\pair#1#2{(#1,#2)}
\\NewDocumentCommand{\\abs}{m}{|#1|}
\\newenvironment{remarque}{}{}
\\begin{document}
\\chapter{Un}\\label{ch:un}
\\begin{verbatim}
\\label{verbatim}
\\end{verbatim}
\\begin{figure}\\caption{x}\\label{fig:x}\\end{figure} % \\label{nope}
\\end{document}`)
    expect(scan.labels.map((label) => [label.name, label.line, label.context])).toEqual([
      ['ch:un', 8, 'chapter'],
      ['fig:x', 12, 'figure'],
    ])
    expect(scan.commands).toEqual(
      expect.arrayContaining([
        { name: 'argmax', arity: 0 },
        { name: 'pair', arity: 2 },
        { name: 'abs', arity: 1 },
      ]),
    )
    expect(scan.environments).toEqual(['remarque'])
    expect(scan.packages).toEqual(['babel', 'tikz', 'class:report'])
  })
})

describe('ProjectIndex', () => {
  it('updates on the fly and notifies subscribers', () => {
    const index = projectIndex()
    let notified = 0
    const unsubscribe = index.subscribe(() => notified++)
    const version = index.version
    index.setFile('chapters/intro.tex', '\\label{new}')
    expect(index.version).toBe(version + 1)
    expect(index.labels().map((label) => label.name)).toContain('new')
    index.renameFile('chapters/intro.tex', 'chapters/start.tex')
    expect(index.labels().find((label) => label.name === 'new')?.file).toBe('chapters/start.tex')
    index.setFiles(['main.tex', 'refs.bib'])
    expect(index.labels().map((label) => label.name)).toEqual(['sec:intro', 'eq:main'])
    index.removeFile('refs.bib')
    expect(index.citations()).toEqual([])
    expect(notified).toBe(4)
    unsubscribe()
    index.setFile('main.tex', '')
    expect(notified).toBe(4)
  })

  it('keeps the first definition of a key defined in several .bib files', () => {
    const index = new ProjectIndex()
    index.setFile('a.bib', '@misc{same, title={A}}')
    index.setFile('b.bib', '@misc{same, title={B}} @misc{other, title={C}}')
    expect(index.citations().map((citation) => [citation.key, citation.file])).toEqual([
      ['same', 'a.bib'],
      ['other', 'b.bib'],
    ])
    index.setFile('broken.bib', '@misc{x, title={')
    expect(index.bibErrors('broken.bib')).toBe(1)
  })

  it('lists the preamble packages of a root document only', () => {
    const index = new ProjectIndex()
    index.setFile(
      'main.tex',
      '\\documentclass{article}\n\\usepackage[utf8]{inputenc}\n\\begin{document}\n\\end{document}',
    )
    index.setFile('chapter.tex', '\\section{A}')
    expect(
      index.preamblePackages('main.tex')?.map((entry) => [entry.name, entry.options, entry.line]),
    ).toEqual([['inputenc', ['utf8'], 2]])
    expect(index.preamblePackages('chapter.tex')).toBeNull()
    expect(index.preamblePackages('absent.tex')).toBeNull()
  })
})
