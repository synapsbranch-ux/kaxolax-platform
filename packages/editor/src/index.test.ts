import { EditorState } from '@codemirror/state'
import { keymap } from '@codemirror/view'
import { describe, expect, it } from 'vitest'
import { findFoldRange, latexExtensions, latexLanguage } from './index.js'

const doc = [
  '\\documentclass{article}', // 1
  '\\begin{document}', // 2
  '\\section{Intro}', // 3
  'Text.', // 4
  '\\begin{itemize}', // 5
  '  \\item a % \\end{itemize} in a comment', // 6
  '  \\begin{itemize}\\item nested\\end{itemize}', // 7
  '\\end{itemize}', // 8
  '\\subsection{Details}', // 9
  'More.', // 10
  '', // 11
  '\\section{Next}', // 12
  'End.', // 13
  '\\end{document}', // 14
].join('\n')

const state = EditorState.create({ doc, extensions: latexExtensions() })
const fold = (line: number) => {
  const range = findFoldRange(state, state.doc.line(line).from)
  return (
    range && { from: state.doc.lineAt(range.from).number, to: state.doc.lineAt(range.to).number }
  )
}

describe('folding', () => {
  it('folds an environment up to its matching \\end, ignoring comments and nesting', () => {
    expect(fold(5)).toEqual({ from: 5, to: 7 })
    expect(fold(2)).toEqual({ from: 2, to: 13 })
  })

  it('folds a section up to the next section of the same level or higher', () => {
    expect(fold(3)).toEqual({ from: 3, to: 10 })
    expect(fold(9)).toEqual({ from: 9, to: 10 })
    expect(fold(12)).toEqual({ from: 12, to: 13 })
  })

  it('does not fold plain lines or single-line environments', () => {
    expect(fold(4)).toBeNull()
    expect(fold(7)).toBeNull()
  })
})

describe('extensions', () => {
  it('uses the LaTeX language with % comments and $ pairs', () => {
    expect(state.facet(latexLanguage.data.reader).some((data) => 'commentTokens' in data)).toBe(
      true,
    )
    const data = state.languageDataAt<{ brackets: string[] }>('closeBrackets', 0)
    expect(data[0]?.brackets).toContain('$')
  })

  it('binds Ctrl/Cmd+Enter to the compile callback', () => {
    let compiled = 0
    const withCallback = EditorState.create({
      extensions: latexExtensions({ onCompile: () => compiled++ }),
    })
    const binding = withCallback
      .facet(keymap)
      .flat()
      .find((entry) => entry.key === 'Mod-Enter')
    expect(binding?.run?.({} as never)).toBe(true)
    expect(compiled).toBe(1)
  })

  it('makes the document read-only on request', () => {
    const readOnly = EditorState.create({ extensions: latexExtensions({ readOnly: true }) })
    expect(readOnly.readOnly).toBe(true)
    expect(state.readOnly).toBe(false)
  })
})
