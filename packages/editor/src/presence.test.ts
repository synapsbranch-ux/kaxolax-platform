// @vitest-environment happy-dom
import { EditorState } from '@codemirror/state'
import { EditorView, keymap } from '@codemirror/view'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { isUserKeystroke, keystrokeListener, revealPosition } from './index.js'

const views: EditorView[] = []
afterEach(() => {
  for (const view of views.splice(0)) view.destroy()
})

function editor(onKeystroke: () => void): EditorView {
  const view = new EditorView({
    state: EditorState.create({ doc: 'a\nb\nc', extensions: keystrokeListener(onKeystroke) }),
    parent: document.body,
  })
  views.push(view)
  return view
}

describe('collaborator presence', () => {
  it('counts every key but lone modifiers as a keystroke', () => {
    expect(isUserKeystroke({ key: 'a' })).toBe(true)
    expect(isUserKeystroke({ key: 'Escape' })).toBe(true)
    expect(isUserKeystroke({ key: 'ArrowDown' })).toBe(true)
    expect(isUserKeystroke({ key: 'Shift' })).toBe(false)
    expect(isUserKeystroke({ key: 'Meta' })).toBe(false)
  })

  it('reports keystrokes typed in the editor', () => {
    const onKeystroke = vi.fn()
    const view = editor(onKeystroke)
    view.contentDOM.dispatchEvent(new KeyboardEvent('keydown', { key: 'Control', bubbles: true }))
    expect(onKeystroke).not.toHaveBeenCalled()
    view.contentDOM.dispatchEvent(new KeyboardEvent('keydown', { key: 'x', bubbles: true }))
    expect(onKeystroke).toHaveBeenCalledTimes(1)
  })

  it('reports keys consumed by a keymap binding', () => {
    const onKeystroke = vi.fn()
    const view = new EditorView({
      state: EditorState.create({
        doc: 'a',
        extensions: [
          keymap.of([{ key: 'Enter', run: () => true }]),
          keystrokeListener(onKeystroke),
        ],
      }),
      parent: document.body,
    })
    views.push(view)
    view.contentDOM.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    expect(onKeystroke).toHaveBeenCalledTimes(1)
  })

  it('scrolls to a position without moving the selection', () => {
    const view = editor(() => undefined)
    const before = view.state.selection
    expect(() => {
      revealPosition(view, 1_000)
    }).not.toThrow()
    expect(view.state.selection.eq(before)).toBe(true)
  })
})
