// @vitest-environment happy-dom
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  autoCompileState,
  isLocalEdit,
  latexExtensions,
  reconfigureEditor,
  setAutoCompile,
  themeSettings,
} from './index.js'

const views: EditorView[] = []
afterEach(() => {
  for (const view of views.splice(0)) view.destroy()
})

function editor(options: Parameters<typeof latexExtensions>[0] = {}): EditorView {
  const view = new EditorView({
    state: EditorState.create({ doc: 'abc', extensions: latexExtensions(options) }),
    parent: document.body,
  })
  views.push(view)
  return view
}

describe('theme and compartments', () => {
  it('uses the dark theme by default and switches theme without recreating the editor', () => {
    const view = editor()
    expect(view.dom.getAttribute('data-theme')).toBe('dark')
    view.dispatch({ selection: { anchor: 2 } })
    reconfigureEditor(view, { theme: 'light', appearance: { fontSize: 16 } })
    expect(view.dom.getAttribute('data-theme')).toBe('light')
    expect(view.state.facet(themeSettings)).toEqual({ mode: 'light', appearance: { fontSize: 16 } })
    // Un changement de police seul garde le mode et fusionne la police.
    reconfigureEditor(view, { appearance: { lineHeight: 1.8 } })
    expect(view.state.facet(themeSettings)).toEqual({
      mode: 'light',
      appearance: { fontSize: 16, lineHeight: 1.8 },
    })
    expect(view.state.doc.toString()).toBe('abc')
    expect(view.state.selection.main.head).toBe(2)
  })

  it('toggles read-only and line wrapping dynamically', () => {
    const view = editor({ theme: 'light' })
    expect(view.state.readOnly).toBe(false)
    reconfigureEditor(view, { readOnly: true })
    expect(view.state.readOnly).toBe(true)
    expect(view.contentDOM.getAttribute('contenteditable')).toBe('false')
    expect(view.contentDOM.classList.contains('cm-lineWrapping')).toBe(true)
    reconfigureEditor(view, { lineWrapping: false })
    expect(view.contentDOM.classList.contains('cm-lineWrapping')).toBe(false)
  })
})

describe('auto-compile', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  const type = (view: EditorView, text: string) => {
    view.dispatch({
      changes: { from: view.state.doc.length, insert: text },
      userEvent: 'input.type',
    })
  }

  it('compiles once after a typing pause', () => {
    const onCompile = vi.fn()
    const view = editor({ autoCompile: { onCompile, delayMs: 1_000 } })
    type(view, 'd')
    vi.advanceTimersByTime(600)
    type(view, 'e')
    vi.advanceTimersByTime(600)
    expect(onCompile).not.toHaveBeenCalled()
    vi.advanceTimersByTime(400)
    expect(onCompile).toHaveBeenCalledOnce()
  })

  it('ignores remote changes (no user event)', () => {
    const onCompile = vi.fn()
    const view = editor({ autoCompile: { onCompile, delayMs: 100 } })
    view.dispatch({ changes: { from: 0, insert: 'x' } })
    vi.advanceTimersByTime(500)
    expect(onCompile).not.toHaveBeenCalled()
  })

  it('accepts a custom filter (Yjs undo applied without user event)', () => {
    const onCompile = vi.fn()
    let undoing = false
    const view = editor({
      autoCompile: { onCompile, delayMs: 100, filter: (tr) => isLocalEdit(tr) || undoing },
    })
    view.dispatch({ changes: { from: 0, insert: 'remote' } })
    vi.advanceTimersByTime(200)
    expect(onCompile).not.toHaveBeenCalled()
    undoing = true
    view.dispatch({ changes: { from: 0, to: 6 } })
    undoing = false
    vi.advanceTimersByTime(100)
    expect(onCompile).toHaveBeenCalledOnce()
  })

  it('can be disabled and re-enabled at runtime, cancelling a pending compile', () => {
    const onCompile = vi.fn()
    const view = editor({ autoCompile: { onCompile, delayMs: 100, enabled: true } })
    type(view, 'x')
    setAutoCompile(view, { enabled: false })
    vi.advanceTimersByTime(500)
    expect(onCompile).not.toHaveBeenCalled()
    expect(autoCompileState(view)).toEqual({ enabled: false, delayMs: 100 })
    setAutoCompile(view, { enabled: true, delayMs: 50 })
    type(view, 'y')
    vi.advanceTimersByTime(50)
    expect(onCompile).toHaveBeenCalledOnce()
  })

  it('follows a preference held by the application', () => {
    let enabled = false
    const onCompile = vi.fn()
    const view = editor({ autoCompile: { onCompile, delayMs: 100, enabled: () => enabled } })
    type(view, 'x')
    vi.advanceTimersByTime(200)
    expect(onCompile).not.toHaveBeenCalled()
    enabled = true
    type(view, 'y')
    vi.advanceTimersByTime(200)
    expect(onCompile).toHaveBeenCalledOnce()
  })
})
