// @vitest-environment happy-dom
import { EditorSelection, EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  commentableSelection,
  commentHighlights,
  commentRanges,
  commentsAt,
  revealComment,
  setActiveComment,
  setCommentRanges,
} from './index.js'

const views: EditorView[] = []
afterEach(() => {
  for (const view of views.splice(0)) view.destroy()
})

function editor(doc: string, onSelect?: (id: string) => void): EditorView {
  const view = new EditorView({
    state: EditorState.create({ doc, extensions: commentHighlights({ onSelect }) }),
    parent: document.body,
  })
  views.push(view)
  return view
}

describe('comment highlights', () => {
  it('draws the ranges and marks the active thread', () => {
    const view = editor('Bonjour le monde')
    view.dispatch({
      effects: [
        setCommentRanges.of([
          { id: 'a', from: 8, to: 10 },
          { id: 'b', from: 11, to: 16 },
          { id: 'hors', from: 12, to: 99 },
        ]),
        setActiveComment.of('b'),
      ],
    })
    const marks = [...view.contentDOM.querySelectorAll('.cm-comment-highlight')]
    expect(marks.map((mark) => mark.textContent)).toEqual(['le', 'monde'])
    expect(view.contentDOM.querySelector('.cm-comment-active')?.textContent).toBe('monde')
  })

  it('maps ranges through local edits until the next update', () => {
    const view = editor('Bonjour le monde')
    view.dispatch({ effects: setCommentRanges.of([{ id: 'a', from: 8, to: 10 }]) })
    view.dispatch({ changes: { from: 0, insert: 'Oh. ' } })
    view.dispatch({ changes: { from: 12, insert: 'X' } }) // juste avant la plage
    expect(commentRanges(view.state)).toEqual([{ id: 'a', from: 13, to: 15 }])
    view.dispatch({ changes: { from: 13, to: 15 } })
    expect(commentRanges(view.state)).toEqual([])
  })

  it('finds the most precise thread under a position', () => {
    const view = editor('abcdefghij')
    view.dispatch({
      effects: setCommentRanges.of([
        { id: 'large', from: 0, to: 10 },
        { id: 'small', from: 2, to: 4 },
      ]),
    })
    expect(commentsAt(view.state, 3)).toEqual(['small', 'large'])
    expect(commentsAt(view.state, 8)).toEqual(['large'])
  })

  it('selects a thread when the user clicks in its text', () => {
    const onSelect = vi.fn()
    const view = editor('abcdefghij', onSelect)
    view.dispatch({ effects: setCommentRanges.of([{ id: 'a', from: 2, to: 4 }]) })
    view.dispatch({ selection: EditorSelection.cursor(3) })
    expect(onSelect).not.toHaveBeenCalled()
    view.dispatch({ selection: EditorSelection.cursor(3), userEvent: 'select.pointer' })
    expect(onSelect).toHaveBeenCalledWith('a')
  })

  it('reads the selection to comment and reveals a range', () => {
    const view = editor('Bonjour le monde')
    expect(commentableSelection(view.state)).toBeNull()
    revealComment(view, 8, 10)
    expect(commentableSelection(view.state)).toEqual({ from: 8, to: 10, text: 'le' })
    revealComment(view, 12, 99)
    expect(commentableSelection(view.state)).toEqual({ from: 12, to: 16, text: 'onde' })
  })
})
