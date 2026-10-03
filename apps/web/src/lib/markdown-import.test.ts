import { EditorState } from '@codemirror/state'
import { pandocRequirements } from '@kaxolax/contracts'
import { describe, expect, it } from 'vitest'
import { ApiError } from './api'
import {
  composeInsertions,
  DEFINITIONS_COMMENT,
  defaultTargetPath,
  includePath,
  insertionRange,
  isMarkdownPath,
  markdownImportErrorMessage,
  pastedTextToReplace,
  planInclude,
  planPreambleMerge,
  preambleMergeMessage,
  type TextInsertion,
} from './markdown-import'

function applyAll(text: string, changes: readonly TextInsertion[]): string {
  return changes.reduce(
    (current, change) => current.slice(0, change.from) + change.insert + current.slice(change.from),
    text,
  )
}

const MAIN = [
  '\\documentclass{article}',
  '\\usepackage[T1]{fontenc}',
  '\\usepackage{graphicx}',
  '\\usepackage{hyperref}',
  '',
  '\\begin{document}',
  'Texte.',
  '\\end{document}',
  '',
].join('\n')

const FRAGMENT = String.raw`\section{A}
Un \href{https://x.org}{lien} et $x$.
\begin{itemize}
\tightlist
\item \st{barré}
\end{itemize}
\pandocbounded{\includegraphics[keepaspectratio]{media/a.png}}`

describe('planPreambleMerge', () => {
  const { packages, definitions } = pandocRequirements(FRAGMENT)

  it('adds the missing packages before hyperref and the definitions before the document', () => {
    const merge = planPreambleMerge(MAIN, packages, definitions)
    expect(merge.added).toEqual(['amsmath', 'amssymb', 'soul'])
    expect(merge.definitions).toEqual(['tightlist', 'pandocbounded'])
    const merged = applyAll(MAIN, merge.changes)
    expect(merged).toContain(
      [
        '\\usepackage{graphicx}',
        '\\usepackage{amsmath}',
        '\\usepackage{amssymb}',
        '\\usepackage{soul}',
        '\\usepackage{hyperref}',
      ].join('\n'),
    )
    expect(merged).toContain(`${DEFINITIONS_COMMENT}\n\\providecommand{\\tightlist}`)
    expect(merged.indexOf('\\makeatother\n\\begin{document}')).toBeGreaterThan(0)
    expect(preambleMergeMessage(merge, 'main.tex')).toBe(
      'Préambule de main.tex complété (packages ajoutés : amsmath, amssymb, soul ; 2 définitions).',
    )

    // Second import : rien à ajouter, aucun doublon.
    const again = planPreambleMerge(merged, packages, definitions)
    expect(again.changes).toEqual([])
    expect(preambleMergeMessage(again, 'main.tex')).toBe(
      'Le préambule de main.tex avait déjà tout le nécessaire.',
    )
  })

  it('reports a package loaded in a list without the requested options', () => {
    const main =
      '\\documentclass{article}\n\\usepackage{soul,xcolor}\n\\begin{document}\n\\end{document}'
    const merge = planPreambleMerge(main, [{ name: 'soul', options: ['normalem'] }], [])
    expect(merge.conflicts).toEqual(['soul'])
    expect(merge.changes).toEqual([])
  })

  it('does nothing without a preamble', () => {
    const merge = planPreambleMerge('\\section{A}', packages, definitions)
    expect(merge.noPreamble).toBe(true)
    expect(merge.changes).toEqual([])
    expect(preambleMergeMessage(merge, 'chapitre.tex')).toContain('n’a pas de préambule')
  })
})

describe('pastedTextToReplace', () => {
  const pasted = { text: '# Titre\n\n**gras**', from: 10, to: 27 }
  const state = {
    source: 'paste' as const,
    localFile: false,
    markdown: pasted.text,
    activeDocumentId: 'doc-1',
    originDocumentId: 'doc-1',
  }

  it('replaces the pasted text by its own conversion, in its document', () => {
    expect(pastedTextToReplace(pasted, state)).toBe(pasted)
  })

  it('inserts at the cursor for another Markdown or another document', () => {
    expect(pastedTextToReplace(undefined, state)).toBeUndefined()
    // Fichier du projet choisi après l'ouverture depuis un collage.
    expect(pastedTextToReplace(pasted, { ...state, source: 'project' })).toBeUndefined()
    // Fichier .md de l'ordinateur chargé dans l'onglet « Coller ».
    expect(
      pastedTextToReplace(pasted, { ...state, localFile: true, markdown: '# Autre' }),
    ).toBeUndefined()
    expect(pastedTextToReplace(pasted, { ...state, localFile: true })).toBeUndefined()
    expect(pastedTextToReplace(pasted, { ...state, markdown: '# Retouché' })).toBeUndefined()
    expect(pastedTextToReplace(pasted, { ...state, activeDocumentId: 'doc-2' })).toBeUndefined()
    expect(pastedTextToReplace(pasted, { ...state, activeDocumentId: null })).toBeUndefined()
  })
})

describe('include', () => {
  it('computes the path from the main document', () => {
    expect(includePath('main.tex', 'chapters/intro.tex')).toBe('chapters/intro')
    expect(includePath('src/main.tex', 'src/ch/one.tex')).toBe('ch/one')
    expect(includePath('src/main.tex', 'notes.tex')).toBe('../notes')
  })

  it('inserts \\input before \\end{document}, once', () => {
    const change = planInclude(MAIN, 'chapters/intro')
    expect(change).not.toBeNull()
    const merged = applyAll(MAIN, change ? [change] : [])
    expect(merged).toContain('Texte.\n\\input{chapters/intro}\n\\end{document}')
    expect(planInclude(merged, 'chapters/intro')).toBeNull()
    expect(planInclude('\\include{chapters/intro}\n\\end{document}', 'chapters/intro')).toBeNull()
    expect(planInclude('\\section{A}', 'chapters/intro')).toBeNull()
  })
})

describe('paths and messages', () => {
  it('derives the target and recognises Markdown files', () => {
    expect(defaultTargetPath('notes/README.md')).toBe('notes/README.tex')
    expect(defaultTargetPath('a.markdown')).toBe('a.tex')
    expect(defaultTargetPath(null)).toBe('imported.tex')
    expect(isMarkdownPath('A.MD')).toBe(true)
    expect(isMarkdownPath('a.tex')).toBe(false)
  })

  it('translates the errors and keeps the cause of a failed conversion', () => {
    expect(
      markdownImportErrorMessage(
        new ApiError(422, 'E_CONVERT_FAILED', 'pandoc could not convert this Markdown: YAML'),
      ),
    ).toBe('La conversion a échoué. pandoc could not convert this Markdown: YAML')
    expect(markdownImportErrorMessage(new ApiError(409, 'E_NAME_TAKEN', 'x'))).toBe(
      'Un fichier porte déjà ce nom : choisissez-en un autre.',
    )
    expect(markdownImportErrorMessage(new ApiError(403, 'E_AI_DISABLED', 'x'))).toBe(
      'L’IA est désactivée pour ce projet.',
    )
  })
})

describe('editor helpers', () => {
  it('applies successive insertions in one change', () => {
    const merge = planPreambleMerge(MAIN, [{ name: 'amsmath', options: [] }], [])
    const include = planInclude(applyAll(MAIN, merge.changes), 'notes')
    const changes = include ? [...merge.changes, include] : merge.changes
    const state = EditorState.create({ doc: MAIN })
    const updated = state.update({ changes: composeInsertions(MAIN.length, changes) }).state
    expect(updated.doc.toString()).toBe(applyAll(MAIN, changes))
  })

  it('replaces the pasted text, even moved by later edits, only if it is still there', () => {
    const text = 'Avant # Titre après'
    const paste = { text: '# Titre', from: 6, to: 13 }
    expect(insertionRange(text, { from: 0, to: 0 }, paste)).toEqual({
      from: 6,
      to: 13,
      replaced: true,
    })
    // Texte déplacé par une modification (locale ou distante) : suivi.
    expect(insertionRange(`Début. ${text}`, { from: 0, to: 0 }, paste)).toEqual({
      from: 13,
      to: 20,
      replaced: true,
    })
    // Plusieurs occurrences : la plus proche de la place d'origine.
    expect(
      insertionRange(
        '# Titre … # Titre … # Titre',
        { from: 0, to: 0 },
        {
          ...paste,
          from: 12,
          to: 19,
        },
      ),
    ).toEqual({ from: 10, to: 17, replaced: true })
    expect(insertionRange(text, { from: 2, to: 2 }, { ...paste, text: '# Autre' })).toEqual({
      from: 2,
      to: 2,
      replaced: false,
    })
    expect(insertionRange(text, { from: 1, to: 3 }, undefined)).toEqual({
      from: 1,
      to: 3,
      replaced: false,
    })
  })
})
