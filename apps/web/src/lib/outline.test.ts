import { currentSection, scanOutline } from '@kaxolax/editor'
import { describe, expect, it } from 'vitest'
import type { ProjectTree } from './api'
import { includedDocuments, MAX_OUTLINE_INCLUDES, projectOutline, resolveInclude } from './outline'

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`

function treeOf(paths: string[]): ProjectTree {
  return {
    mainDocumentId: id(0),
    folders: [],
    documents: paths.map((path, index) => ({
      id: id(index),
      folderId: null,
      name: path.split('/').at(-1) ?? path,
      path,
    })),
    files: [],
  }
}

describe('resolveInclude', () => {
  const tree = treeOf(['thesis/main.tex', 'thesis/chapters/intro.tex', 'shared/macros.tex'])

  it('resolves from the main file folder, adding .tex', () => {
    expect(
      resolveInclude(
        tree,
        { command: 'include', path: 'chapters/intro' },
        'thesis/main.tex',
        'thesis/main.tex',
      )?.path,
    ).toBe('thesis/chapters/intro.tex')
  })

  it('falls back to the project root and refuses paths outside the project', () => {
    expect(
      resolveInclude(
        tree,
        { command: 'input', path: '../shared/macros' },
        'thesis/main.tex',
        'thesis/main.tex',
      )?.path,
    ).toBe('shared/macros.tex')
    expect(
      resolveInclude(tree, { command: 'input', path: '../../x' }, 'thesis/main.tex', null),
    ).toBeNull()
  })
})

describe('project outline', () => {
  const tree = treeOf(['main.tex', 'intro.tex', 'loop.tex'])
  const main = tree.documents[0]
  if (main === undefined) throw new Error('main')
  const mainItems = scanOutline(
    '\\begin{document}\n\\section{Start}\n\\input{intro}\n\\section{End}\n\\end{document}\n',
  )
  const introItems = scanOutline('\\subsection{Inside}\n\\input{loop}\n')
  const loopItems = scanOutline('\\input{intro}\n\\subsection{Loop}\n')

  it('lists included documents level by level, without cycles', () => {
    expect(
      includedDocuments(tree, { document: main, items: mainItems }, new Map(), 'main.tex').map(
        (document) => document.path,
      ),
    ).toEqual(['intro.tex'])
    const known = new Map([
      [id(1), introItems],
      [id(2), loopItems],
    ])
    expect(
      includedDocuments(tree, { document: main, items: mainItems }, known, 'main.tex').map(
        (document) => document.path,
      ),
    ).toEqual(['intro.tex', 'loop.tex'])
  })

  it('merges the headings of included files and finds the current section per file', () => {
    const known = new Map([
      [id(1), introItems],
      [id(2), loopItems],
    ])
    const nodes = projectOutline(tree, { document: main, items: mainItems }, known, 'main.tex')
    expect(nodes.map((node) => node.title)).toEqual(['Start', 'End'])
    expect(nodes[0]?.children.map((node) => [node.title, node.file])).toEqual([
      ['Inside', 'intro.tex'],
      ['Loop', 'loop.tex'],
    ])
    // Curseur après « End » dans main.tex : les titres des fichiers inclus ne comptent pas.
    expect(currentSection(nodes, 60, 'main.tex')?.title).toBe('End')
  })

  it('caps the number of included documents', () => {
    const many = treeOf(['main.tex', ...Array.from({ length: 40 }, (_, n) => `c${String(n)}.tex`)])
    const root = many.documents[0]
    if (root === undefined) throw new Error('root')
    const items = scanOutline(
      Array.from({ length: 40 }, (_, n) => `\\input{c${String(n)}}`).join('\n'),
    )
    expect(includedDocuments(many, { document: root, items }, new Map(), null)).toHaveLength(
      MAX_OUTLINE_INCLUDES,
    )
  })
})
