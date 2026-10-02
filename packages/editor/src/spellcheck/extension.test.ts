// @vitest-environment happy-dom
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { latexExtensions, reconfigureEditor } from '../index.js'
import { SpellcheckClient, type SpellWorkerLike } from './client.js'
import {
  misspelledRanges,
  misspellingAt,
  openSpellcheckMenu,
  type SpellcheckConfig,
  type SpellcheckMenu,
  spellcheckConfigOf,
} from './extension.js'
import { SpellService, serveSpellcheck } from './service.js'

const KNOWN = new Set(['le', 'chat', 'dort', 'Le', 'bien', 'chien'])

const engine = {
  correct: (word: string) => KNOWN.has(word),
  suggest: (word: string) => (word === 'chta' ? ['chat'] : []),
}

function client(
  load: () => Promise<typeof engine> = () => Promise.resolve(engine),
): SpellcheckClient {
  const service = new SpellService(load)
  const page = new Set<(event: { data: unknown }) => void>()
  const worker = new Set<(event: { data: unknown }) => void>()
  serveSpellcheck(
    {
      postMessage: (message) => {
        for (const listener of page) listener({ data: message })
      },
      addEventListener: (_type, listener) => worker.add(listener),
    },
    service,
  )
  const like: SpellWorkerLike = {
    postMessage: (message) => {
      for (const listener of worker) listener({ data: message })
    },
    addEventListener: (_type, listener) => page.add(listener),
    removeEventListener: (_type, listener) => page.delete(listener),
  }
  return new SpellcheckClient(like)
}

const views: EditorView[] = []
afterEach(() => {
  for (const view of views.splice(0)) view.destroy()
})

function editor(doc: string, config: SpellcheckConfig | null): EditorView {
  const view = new EditorView({
    state: EditorState.create({ doc, extensions: latexExtensions({ spellcheck: config }) }),
    parent: document.body,
  })
  views.push(view)
  return view
}

async function settle(view: EditorView, count: number): Promise<void> {
  const start = Date.now()
  while (misspelledRanges(view.state).length !== count && Date.now() - start < 2000) {
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

describe('spellcheck extension', () => {
  it('underlines unknown words outside commands and math', async () => {
    const view = editor('Le chta \\textbf{dort} $chta$ \\label{chta} biien', {
      client: client(),
      language: 'fr',
      delayMs: 0,
    })
    await settle(view, 2)
    const ranges = misspelledRanges(view.state).map(({ from, to }) => view.state.sliceDoc(from, to))
    expect(ranges).toEqual(['chta', 'biien'])
    expect(view.dom.querySelectorAll('.cm-spellError')).toHaveLength(2)
  })

  it('removes the underline of an edited word and rechecks after a pause', async () => {
    const view = editor('Le chta dort', { client: client(), language: 'fr', delayMs: 0 })
    await settle(view, 1)
    view.dispatch({ changes: { from: 3, to: 7, insert: 'chat' } })
    expect(misspelledRanges(view.state)).toEqual([])
    view.dispatch({ changes: { from: 12, insert: ' chiein' } })
    await settle(view, 1)
    expect(misspellingAt(view.state, 15)?.word).toBe('chiein')
  })

  it('opens the suggestions menu and replaces the word or adds it to the dictionary', async () => {
    const onMenu = vi.fn<(menu: SpellcheckMenu) => void>()
    const onAddToDictionary = vi.fn()
    const view = editor('Le chta dort', {
      client: client(),
      language: 'fr',
      delayMs: 0,
      onMenu,
      onAddToDictionary,
    })
    await settle(view, 1)
    view.dispatch({ selection: { anchor: 5 } })
    expect(openSpellcheckMenu(view)).toBe(true)
    const menu = onMenu.mock.calls[0]?.[0]
    if (!menu) throw new Error('menu expected')
    expect(menu).toMatchObject({ word: 'chta', from: 3, to: 7 })
    expect(await menu.suggestions()).toEqual(['chat'])
    menu.addToDictionary()
    expect(onAddToDictionary).toHaveBeenCalledWith('chta')
    menu.replace('chat')
    expect(view.state.doc.toString()).toBe('Le chat dort')
    // Plus de mot souligné sous le curseur : pas de menu.
    expect(openSpellcheckMenu(view)).toBe(false)
  })

  it('rechecks when the personal dictionary changes', async () => {
    const spell = client()
    const view = editor('Le chta dort', { client: spell, language: 'fr', delayMs: 0 })
    await settle(view, 1)
    await spell.setPersonalDictionary(['chta'])
    await settle(view, 0)
    expect(misspelledRanges(view.state)).toEqual([])
  })

  it('reports a failed check, then a check that succeeds after the retry', async () => {
    let attempts = 0
    const spell = client(() =>
      ++attempts === 1 ? Promise.reject(new Error('offline')) : Promise.resolve(engine),
    )
    const onError = vi.fn()
    const onChecked = vi.fn()
    const view = editor('Le chta dort', {
      client: spell,
      language: 'fr',
      delayMs: 0,
      onError,
      onChecked,
    })
    await vi.waitFor(() => {
      expect(onError).toHaveBeenCalledTimes(1)
    })
    expect(onChecked).not.toHaveBeenCalled()
    view.dispatch({ changes: { from: view.state.doc.length, insert: ' bien' } })
    await settle(view, 1)
    expect(onChecked).toHaveBeenCalled()
  })

  it('is switched on and off without recreating the editor', async () => {
    const config: SpellcheckConfig = { client: client(), language: 'fr', delayMs: 0 }
    const view = editor('Le chta dort', null)
    expect(spellcheckConfigOf(view.state)).toBeNull()
    reconfigureEditor(view, { spellcheck: config })
    await settle(view, 1)
    expect(spellcheckConfigOf(view.state)).toBe(config)
    reconfigureEditor(view, { spellcheck: null })
    expect(misspelledRanges(view.state)).toEqual([])
    expect(view.dom.querySelectorAll('.cm-spellError')).toHaveLength(0)
  })
})
