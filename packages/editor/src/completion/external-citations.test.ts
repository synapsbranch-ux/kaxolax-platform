// @vitest-environment happy-dom
import { CompletionContext } from '@codemirror/autocomplete'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  type CitationProvider,
  correctInsertedKey,
  type ExternalCitation,
  externalCitationSource,
  insertCitation,
} from './external-citations.js'
import { ProjectIndex } from './project-index.js'

const LOVELACE: ExternalCitation = {
  key: 'lovelace_notes_1843',
  detail: 'Lovelace 1843',
  title: 'Notes on the Analytical Engine',
  id: 'AAAA2222',
}
const BABBAGE: ExternalCitation = {
  key: 'babbage_1864',
  detail: 'Babbage 1864',
  title: 'Passages',
  id: 'BBBB3333',
}

function fakeProvider(results: readonly ExternalCitation[] = [LOVELACE, BABBAGE]) {
  const searches: string[] = []
  const picked: ExternalCitation[] = []
  const provider: CitationProvider = {
    name: 'Zotero',
    search: (query) => {
      searches.push(query)
      return Promise.resolve(results)
    },
    pick: (citation) => {
      picked.push(citation)
    },
  }
  return { provider, searches, picked }
}

function contextOf(marked: string): CompletionContext {
  const pos = marked.indexOf('|')
  return new CompletionContext(EditorState.create({ doc: marked.replace('|', '') }), pos, false)
}

const views: EditorView[] = []
function viewOf(marked: string): EditorView {
  const pos = marked.indexOf('|')
  const view = new EditorView({
    state: EditorState.create({
      doc: marked.replace('|', ''),
      selection: { anchor: pos },
    }),
    parent: document.body,
  })
  views.push(view)
  return view
}

afterEach(() => {
  for (const view of views.splice(0)) view.destroy()
})

describe('external citation source', () => {
  it('searches the typed text after \\cite{ and skips keys already in the project', async () => {
    const { provider, searches } = fakeProvider()
    const index = new ProjectIndex()
    index.setFile('refs.bib', '@book{babbage_1864, title = {Passages}}')
    const source = externalCitationSource({
      provider: () => provider,
      sources: () => index,
      delayMs: 0,
    })
    const result = await source(contextOf('voir \\citep[p.~2]{knuth, engi|}'))
    expect(searches).toEqual(['engi'])
    expect(result?.from).toBe('voir \\citep[p.~2]{knuth, '.length)
    expect(result?.filter).toBe(false)
    expect(result?.options.map((option) => [option.label, option.detail, option.info])).toEqual([
      ['lovelace_notes_1843', 'Lovelace 1843 · Zotero', 'Notes on the Analytical Engine'],
    ])
  })

  it('stays quiet outside citations, for short text or without provider', async () => {
    const { provider, searches } = fakeProvider()
    const source = externalCitationSource({ provider: () => provider, delayMs: 0 })
    expect(await source(contextOf('\\ref{eng|}'))).toBeNull()
    expect(await source(contextOf('\\cite{e|}'))).toBeNull()
    expect(await source(contextOf('engine|'))).toBeNull()
    expect(searches).toEqual([])
    const none = externalCitationSource({ provider: () => null, delayMs: 0 })
    expect(await none(contextOf('\\cite{engine|}'))).toBeNull()
  })

  it('returns nothing when the search fails', async () => {
    const provider: CitationProvider = {
      name: 'Zotero',
      search: () => Promise.reject(new Error('offline')),
      pick: vi.fn(),
    }
    const source = externalCitationSource({ provider: () => provider, delayMs: 0 })
    expect(await source(contextOf('\\cite{engine|}'))).toBeNull()
  })

  it('inserts the key and asks the provider to add the entry', async () => {
    const { provider, picked } = fakeProvider([LOVELACE])
    const view = viewOf('\\cite{engi|}')
    const source = externalCitationSource({ provider: () => provider, delayMs: 0 })
    const result = await source(
      new CompletionContext(view.state, view.state.selection.main.head, false),
    )
    const option = result?.options[0]
    const apply = option?.apply
    if (option === undefined || typeof apply !== 'function') throw new Error('apply expected')
    apply(view, option, result?.from ?? 0, view.state.selection.main.head)
    expect(view.state.doc.toString()).toBe('\\cite{lovelace_notes_1843}')
    expect(picked).toEqual([LOVELACE])
  })

  it('replaces the inserted key with the one finally kept by the provider', async () => {
    const provider: CitationProvider = {
      name: 'Zotero',
      search: () => Promise.resolve([LOVELACE]),
      pick: () => Promise.resolve('lovelace_notes_1843a'),
    }
    const view = viewOf('\\cite{engi|}')
    const source = externalCitationSource({ provider: () => provider, delayMs: 0 })
    const result = await source(
      new CompletionContext(view.state, view.state.selection.main.head, false),
    )
    const option = result?.options[0]
    const apply = option?.apply
    if (option === undefined || typeof apply !== 'function') throw new Error('apply expected')
    apply(view, option, result?.from ?? 0, view.state.selection.main.head)
    await Promise.resolve()
    await Promise.resolve()
    expect(view.state.doc.toString()).toBe('\\cite{lovelace_notes_1843a}')
  })

  it('removes the inserted key when the entry could not be added', async () => {
    for (const pick of [() => Promise.resolve(null), () => Promise.reject(new Error('503'))]) {
      const provider: CitationProvider = {
        name: 'Zotero',
        search: () => Promise.resolve([LOVELACE]),
        pick,
      }
      const view = viewOf('\\cite{engi|}')
      const source = externalCitationSource({ provider: () => provider, delayMs: 0 })
      const result = await source(
        new CompletionContext(view.state, view.state.selection.main.head, false),
      )
      const option = result?.options[0]
      const apply = option?.apply
      if (option === undefined || typeof apply !== 'function') throw new Error('apply expected')
      apply(view, option, result?.from ?? 0, view.state.selection.main.head)
      expect(view.state.doc.toString()).toBe('\\cite{lovelace_notes_1843}')
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(view.state.doc.toString()).toBe('\\cite{engi}')
    }
  })

  it('leaves the text alone when the inserted key is no longer there', () => {
    const view = viewOf('\\cite{other}|')
    expect(correctInsertedKey(view, 6, 'lovelace', 'lovelace_a')).toBe(false)
    expect(correctInsertedKey(view, 6, 'other', 'other')).toBe(false)
    expect(correctInsertedKey(view, 6, 'other', 'other_a')).toBe(true)
    expect(view.state.doc.toString()).toBe('\\cite{other_a}')
  })
})

describe('insertCitation', () => {
  it('wraps the key in \\cite outside a citation, replacing the selection', () => {
    const view = viewOf('Voir | ici.')
    expect(insertCitation(view, 'knuth84')).toBe(true)
    expect(view.state.doc.toString()).toBe('Voir \\cite{knuth84} ici.')
    expect(view.state.selection.main.head).toBe('Voir \\cite{knuth84}'.length)
  })

  it('adds the key to the list of the citation under the cursor', () => {
    const empty = viewOf('\\cite{|}')
    insertCitation(empty, 'a')
    expect(empty.state.doc.toString()).toBe('\\cite{a}')
    const afterComma = viewOf('\\parencite{a,|}')
    insertCitation(afterComma, 'b')
    expect(afterComma.state.doc.toString()).toBe('\\parencite{a,b}')
    const afterKey = viewOf('\\citep{a|}')
    insertCitation(afterKey, 'b')
    expect(afterKey.state.doc.toString()).toBe('\\citep{a,b}')
  })

  it('does nothing in a read-only editor', () => {
    const view = new EditorView({
      state: EditorState.create({ doc: 'x', extensions: EditorState.readOnly.of(true) }),
      parent: document.body,
    })
    views.push(view)
    expect(insertCitation(view, 'a')).toBe(false)
    expect(view.state.doc.toString()).toBe('x')
  })
})
