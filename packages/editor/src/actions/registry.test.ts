// @vitest-environment happy-dom
import { EditorState } from '@codemirror/state'
import { EditorView, runScopeHandlers } from '@codemirror/view'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { latexExtensions } from '../index.js'
import { canEdit, createActionRegistry, type EditorAction } from './registry.js'

const views: EditorView[] = []
afterEach(() => {
  for (const view of views.splice(0)) view.destroy()
})

function action(id: string, extra: Partial<EditorAction> = {}): EditorAction {
  return { id, label: id, menu: 'format', run: () => true, ...extra }
}

/** Simule une frappe clavier sur l'éditeur ; vrai si un raccourci l'a traitée. */
function press(view: EditorView, key: string, modifiers: KeyboardEventInit = {}): boolean {
  return runScopeHandlers(view, new KeyboardEvent('keydown', { key, ...modifiers }), 'editor')
}

describe('action registry', () => {
  it('registers, finds and unregisters actions', () => {
    const registry = createActionRegistry()
    const listener = vi.fn()
    registry.subscribe(listener)
    const dispose = registry.register([action('format.a'), action('format.b')])
    expect(registry.get('format.a')?.id).toBe('format.a')
    expect(registry.all()).toHaveLength(2)
    expect(listener).toHaveBeenCalledTimes(1)
    dispose()
    expect(registry.get('format.a')).toBeUndefined()
    expect(listener).toHaveBeenCalledTimes(2)
    dispose()
    expect(listener).toHaveBeenCalledTimes(2)
  })

  it('refuses duplicate ids without registering anything', () => {
    const registry = createActionRegistry([action('format.a')])
    expect(() => registry.register([action('format.b'), action('format.a')])).toThrow(
      /already registered/,
    )
    expect(registry.get('format.b')).toBeUndefined()
  })

  it('lists a menu grouped by first appearance of each group', () => {
    const registry = createActionRegistry([
      action('a', { group: 'x' }),
      action('b', { group: 'y' }),
      action('c', { group: 'x' }),
      action('d', { menu: 'math' }),
    ])
    expect(registry.byMenu('format').map((item) => item.id)).toEqual(['a', 'c', 'b'])
    expect(registry.byMenu('math').map((item) => item.id)).toEqual(['d'])
    expect(registry.byMenu('file')).toEqual([])
  })

  it('runs only enabled actions and reports whether something happened', () => {
    const run = vi.fn(() => true)
    const registry = createActionRegistry([
      action('a', { run, when: canEdit }),
      action('b', { run: () => false }),
      action('c', { run: () => undefined }),
    ])
    expect(registry.run('a', { view: null, host: {} })).toBe(false)
    expect(run).not.toHaveBeenCalled()
    expect(registry.run('b', { view: null, host: {} })).toBe(false)
    expect(registry.run('c', { view: null, host: {} })).toBe(true)
    expect(registry.run('missing', { view: null, host: {} })).toBe(false)
  })

  it('reports errors of asynchronous actions to the application', async () => {
    const notify = vi.fn()
    const registry = createActionRegistry([
      action('a', { run: () => Promise.reject(new Error('boom')) }),
    ])
    expect(registry.run('a', { view: null, host: { notify } })).toBe(true)
    await vi.waitFor(() => {
      expect(notify).toHaveBeenCalledWith('boom', 'error')
    })
  })

  it('binds shortcuts, before the default keymap, and follows later registrations', async () => {
    const bold = vi.fn(() => true)
    const registry = createActionRegistry([action('bold', { shortcut: 'Mod-b', run: bold })])
    const host = { readOnly: false }
    const view = new EditorView({
      state: EditorState.create({
        extensions: latexExtensions({ actions: { registry, host } }),
      }),
      parent: document.body,
    })
    views.push(view)

    expect(press(view, 'b', { ctrlKey: true })).toBe(true)
    expect(bold).toHaveBeenCalledOnce()

    // Mod-i est lié par défaut à selectParentSyntax : l'action enregistrée ensuite l'emporte.
    const italic = vi.fn(() => true)
    const dispose = registry.register(action('italic', { shortcut: 'Mod-i', run: italic }))
    await Promise.resolve()
    expect(press(view, 'i', { ctrlKey: true })).toBe(true)
    expect(italic).toHaveBeenCalledOnce()

    dispose()
    await Promise.resolve()
    press(view, 'i', { ctrlKey: true })
    expect(italic).toHaveBeenCalledOnce()
  })

  it('lets a disabled shortcut fall through to other bindings', () => {
    const registry = createActionRegistry([action('a', { shortcut: 'Mod-b', when: () => false })])
    const view = new EditorView({
      state: EditorState.create({
        extensions: latexExtensions({ actions: { registry, host: () => ({}) } }),
      }),
      parent: document.body,
    })
    views.push(view)
    expect(press(view, 'b', { ctrlKey: true })).toBe(false)
  })
})
