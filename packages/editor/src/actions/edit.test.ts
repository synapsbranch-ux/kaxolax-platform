import { EditorState } from '@codemirror/state'
import { describe, expect, it } from 'vitest'
import { marked, runCommand, stateOf, undoOnce } from '../test-utils.js'
import { CURSOR, editCommand, inlineSnippet, isActionTransaction, toggleWrap } from './edit.js'

const bold = editCommand(toggleWrap('\\textbf{', '}'))
const italic = editCommand(toggleWrap('\\textit{', '}'))

describe('edit commands', () => {
  it('keeps one undo step per action, even for consecutive actions', () => {
    const start = stateOf('«word»')
    const once = runCommand(start, bold)
    const twice = runCommand(once, italic)
    expect(marked(twice)).toBe('\\textbf{\\textit{«word»}}')
    expect(marked(undoOnce(twice))).toBe('\\textbf{«word»}')
    expect(marked(undoOnce(undoOnce(twice)))).toBe('«word»')
  })

  it('marks its transactions as actions', () => {
    let action = false
    bold({
      state: stateOf('|'),
      dispatch: (transaction) => {
        action = isActionTransaction(transaction)
      },
    })
    expect(action).toBe(true)
  })

  it('does nothing on a read-only state', () => {
    const state = stateOf('«a»', EditorState.readOnly.of(true))
    expect(bold({ state, dispatch: () => undefined })).toBe(false)
  })

  it('does not unwrap unbalanced braces', () => {
    expect(marked(runCommand(stateOf('\\textbf{«a}{b»}'), bold))).toBe('\\textbf{\\textbf{«a}{b»}}')
  })

  it('places snippet cursors around a selection without rewriting it', () => {
    const command = editCommand(inlineSnippet(`\\href{${CURSOR}}{`, '}'))
    expect(marked(runCommand(stateOf('«site»'), command))).toBe('\\href{|}{site}')
    expect(marked(runCommand(stateOf('|'), command))).toBe('\\href{|}{}')
  })
})
