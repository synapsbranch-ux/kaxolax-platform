import { Text } from '@codemirror/state'
import { describe, expect, it } from 'vitest'
import {
  cleanTitle,
  currentSection,
  currentSectionPath,
  expandOutline,
  extractOutline,
  includeCandidates,
  type OutlineNode,
  type OutlineSource,
  scanOutline,
} from './outline.js'

/** Arbre réduit aux titres et niveaux, pour des comparaisons lisibles. */
function shape(nodes: readonly OutlineNode[]): unknown[] {
  return nodes.map((node) =>
    node.children.length === 0 ? node.title : [node.title, shape(node.children)],
  )
}

const thesis = [
  '\\documentclass{report}', // 1
  '\\usepackage{amsmath}', // 2
  '\\newcommand{\\section}{x} % dans le préambule : ignoré', // 3
  '\\begin{document}', // 4
  '\\chapter{Introduction}\\label{ch:intro}', // 5
  'Texte.', // 6
  '\\section[Court]{Un titre \\emph{très} long}', // 7
  '% \\section{Commentée}', // 8
  '\\subsection*{Non numérotée}', // 9
  '\\begin{verbatim}', // 10
  '\\section{Dans un verbatim}', // 11
  '\\end{verbatim}', // 12
  '\\section{Maths $x^2$ et 50\\,\\%}', // 13
  '\\input{chapters/methods}', // 14
  '\\chapter{Conclusion}', // 15
  '\\paragraph{Détail}', // 16
  '\\end{document}', // 17
  '\\section{Après la fin}', // 18
].join('\n')

describe('outline', () => {
  it('builds the tree of a real document, ignoring preamble, comments and verbatim', () => {
    expect(shape(extractOutline(thesis))).toEqual([
      ['Introduction', [['Un titre très long', ['Non numérotée']], 'Maths $x^2$ et 50 %']],
      ['Conclusion', ['Détail']],
    ])
  })

  it('records level, line, position, star and short title', () => {
    const [intro] = extractOutline(thesis)
    expect(intro).toMatchObject({ level: 1, command: 'chapter', line: 5, starred: false })
    expect(intro?.from).toBe(thesis.indexOf('\\chapter{Introduction}'))
    const section = intro?.children[0]
    expect(section).toMatchObject({ level: 2, shortTitle: 'Court', line: 7 })
    expect(section?.children[0]).toMatchObject({ starred: true, level: 3, line: 9 })
  })

  it('reports \\input and \\include so the app can descend into them', () => {
    const includes = scanOutline(thesis).filter((item) => item.kind === 'include')
    expect(includes).toEqual([
      expect.objectContaining({ command: 'input', path: 'chapters/methods', line: 14 }),
    ])
    expect(
      scanOutline('\\include{a}\n\\input b\n\\import{dir/}{c}').map((item) =>
        item.kind === 'include' ? item.path : null,
      ),
    ).toEqual(['a', 'b', 'dir/c'])
  })

  it('reads a file without preamble (included chapter) and titles over several lines', () => {
    const tree = extractOutline('\\section{Un titre\n  sur deux lignes}\nTexte\n\\section{B}')
    expect(shape(tree)).toEqual(['Un titre sur deux lignes', 'B'])
    expect(tree[1]?.line).toBe(4)
  })

  it('accepts a CodeMirror Text and escaped percent signs', () => {
    const doc = Text.of(['\\section{100\\% réel} % commentaire', '\\section{B}'])
    expect(shape(extractOutline(doc))).toEqual(['100% réel', 'B'])
  })

  it('handles skipped levels and a starting subsection', () => {
    expect(shape(extractOutline('\\subsection{a}\n\\section{b}\n\\subsubsection{c}'))).toEqual([
      'a',
      ['b', ['c']],
    ])
  })

  it('cleans titles', () => {
    expect(cleanTitle('\\textbf{Gras} et \\LaTeX~2\\label{x}\\footnote{note}')).toBe(
      'Gras et LaTeX 2',
    )
  })

  it('finds the current section from a position', () => {
    const tree = extractOutline(thesis)
    expect(currentSection(tree, 0)).toBeNull()
    const inSubsection = thesis.indexOf('\\begin{verbatim}')
    expect(currentSection(tree, inSubsection)?.title).toBe('Non numérotée')
    expect(currentSectionPath(tree, inSubsection).map((node) => node.title)).toEqual([
      'Introduction',
      'Un titre très long',
      'Non numérotée',
    ])
    expect(currentSection(tree, thesis.length)?.title).toBe('Détail')
  })

  it('expands included files and keeps the current section per file', () => {
    const files: Record<string, string> = {
      'main.tex': '\\begin{document}\n\\chapter{A}\n\\input{part}\n\\chapter{C}\n\\end{document}',
      'part.tex': '\\section{B}\n\\input{main}',
    }
    const source = (file: string): OutlineSource => ({
      file,
      items: scanOutline(files[file] ?? ''),
    })
    const headings = expandOutline(source('main.tex'), (include) => {
      const name = includeCandidates(include).find((candidate) => candidate in files)
      return name === undefined ? null : source(name)
    })
    expect(headings.map((heading) => `${heading.file ?? ''}:${heading.title}`)).toEqual([
      'main.tex:A',
      'part.tex:B',
      'main.tex:C',
    ])
    expect(includeCandidates({ command: 'include', path: './x' })).toEqual(['x.tex'])
  })

  it('stays fast on documents of thousands of lines', () => {
    const lines: string[] = ['\\begin{document}']
    for (let i = 0; i < 2_000; i++) {
      lines.push(`\\section{S${String(i)}}`, 'Du texte avec \\emph{commandes} et $x$.', '% note')
      for (let j = 0; j < 5; j++) lines.push(`Ligne ${String(j)} \\cite{k${String(j)}} texte.`)
    }
    const doc = lines.join('\n')
    const start = performance.now()
    const tree = extractOutline(doc)
    expect(tree).toHaveLength(2_000)
    expect(performance.now() - start).toBeLessThan(500)
  })
})
