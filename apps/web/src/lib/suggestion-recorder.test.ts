import { applySuggestion, resolveSuggestion, TEXT_FIELD } from '@kaxolax/collab'
import type { CreateSuggestionInput, Suggestion, UpdateSuggestionInput } from '@kaxolax/contracts'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as Y from 'yjs'
import { SuggestionRecorder, type SuggestionTransport } from './suggestion-recorder'

const AUTHOR = '00000000-0000-4000-8000-000000000001'
const DOCUMENT = '00000000-0000-4000-8000-0000000000d0'

/** Faux service : suggestions enregistrées, appels notés dans l'ordre. */
class FakeTransport implements SuggestionTransport {
  readonly calls: string[] = []
  readonly stored = new Map<string, CreateSuggestionInput>()
  private serial = 0
  failNext: Error | null = null
  /** Réponse retenue jusqu'à sa résolution (envoi en cours). */
  hold: Promise<void> | null = null

  private suggestion(id: string, input: CreateSuggestionInput): Suggestion {
    return {
      id,
      documentId: input.documentId,
      author: { id: AUTHOR, fullName: 'Grace Hopper', avatarUrl: null },
      origin: 'user',
      kind: input.kind,
      anchor: input.anchor,
      originalText: input.originalText,
      proposedText: input.proposedText,
      status: 'open',
      decidedBy: null,
      decidedAt: null,
      aiMessageId: null,
      createdAt: '2026-10-03T10:00:00.000Z',
    }
  }

  private check(): void {
    const failure = this.failNext
    this.failNext = null
    if (failure) throw failure
  }

  create = async (input: CreateSuggestionInput) => {
    await Promise.resolve()
    this.check()
    this.serial += 1
    const id = `00000000-0000-4000-8000-${String(this.serial).padStart(12, '0')}`
    this.calls.push(`create ${input.kind} «${input.originalText}»→«${input.proposedText}»`)
    this.stored.set(id, input)
    return this.suggestion(id, input)
  }

  update = async (id: string, input: UpdateSuggestionInput) => {
    await Promise.resolve()
    if (this.hold) await this.hold
    this.check()
    const previous = this.stored.get(id)
    if (!previous) throw new Error('unknown suggestion')
    const next = { ...previous, ...input }
    this.calls.push(`update ${input.kind} «${input.originalText}»→«${input.proposedText}»`)
    this.stored.set(id, next)
    return this.suggestion(id, next)
  }

  remove = async (id: string) => {
    await Promise.resolve()
    this.check()
    this.calls.push('remove')
    this.stored.delete(id)
  }
}

function setup(content = 'Hello world!') {
  const doc = new Y.Doc()
  const text = doc.getText(TEXT_FIELD)
  text.insert(0, content)
  const transport = new FakeTransport()
  const hooks = {
    onSaved: vi.fn(),
    onRemoved: vi.fn(),
    onError: vi.fn(),
    onRejected: vi.fn(),
    onChange: vi.fn(),
  }
  const recorder = new SuggestionRecorder(text, DOCUMENT, AUTHOR, transport, hooks, 100)
  /**
   * Éditeur simulé : curseur (et sélection) dans le document, comme l'extension de l'éditeur le
   * place après chaque frappe interceptée, puis corrigé par l'enregistreur.
   */
  const editor = {
    anchor: 0,
    head: 0,
    place(at: number) {
      editor.anchor = at
      editor.head = at
    },
    select(from: number, to: number) {
      editor.anchor = from
      editor.head = to
    },
    apply(from: number, to: number, insert: string, cursor: number) {
      const next = recorder.edit({ from, to, insert, cursor })
      editor.place(next ?? cursor)
    },
    type(characters: string) {
      for (const character of characters) {
        const from = Math.min(editor.anchor, editor.head)
        const to = Math.max(editor.anchor, editor.head)
        editor.apply(from, to, character, to)
      }
    },
    backspace(times = 1) {
      for (let index = 0; index < times; index++) {
        editor.apply(editor.head - 1, editor.head, '', editor.head - 1)
      }
    },
    deleteForward() {
      editor.apply(editor.head, editor.head + 1, '', editor.head + 1)
    },
  }
  return { doc, text, transport, hooks, recorder, editor }
}

/** Texte du document une fois chaque suggestion enregistrée acceptée. */
function accepted(text: Y.Text, transport: FakeTransport): string {
  for (const [id, input] of transport.stored) {
    applySuggestion(text, { id, ...input }, { decidedBy: AUTHOR })
  }
  return text.toJSON()
}

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

describe('SuggestionRecorder', () => {
  it('merges keystrokes into one suggestion, created once after a pause', async () => {
    const { text, transport, recorder, editor } = setup()
    editor.place(5)
    editor.type(', dear')
    expect(text.toJSON()).toBe('Hello world!')
    const [draft] = recorder.drafts()
    expect(draft?.pending).toMatchObject({ kind: 'insert', proposedText: ', dear' })
    expect(transport.calls).toEqual([])
    await vi.advanceTimersByTimeAsync(150)
    expect(transport.calls).toEqual(['create insert «»→«, dear»'])
    // La suite de la frappe modifie la même suggestion.
    editor.type(' old')
    await vi.advanceTimersByTimeAsync(150)
    expect(transport.calls).toEqual(['create insert «»→«, dear»', 'update insert «»→«, dear old»'])
    expect(accepted(text, transport)).toBe('Hello, dear old world!')
  })

  it('turns backspaces into a deletion that grows backwards', async () => {
    const { text, transport, editor } = setup()
    editor.place(11)
    editor.backspace(3)
    expect(editor.head).toBe(8)
    await vi.advanceTimersByTimeAsync(150)
    expect(transport.calls).toEqual(['create delete «rld»→«»'])
    expect(accepted(text, transport)).toBe('Hello wo!')
  })

  it('grows a deletion forwards', async () => {
    const { text, transport, editor } = setup()
    editor.place(0)
    editor.deleteForward()
    editor.deleteForward()
    await vi.advanceTimersByTimeAsync(150)
    expect(transport.calls).toEqual(['create delete «He»→«»'])
    expect(accepted(text, transport)).toBe('llo world!')
  })

  it('keeps one replacement while a word is retyped, backspaces included', async () => {
    const { text, transport, editor } = setup()
    editor.select(6, 11)
    // « mond » partage le « d » final avec « world » : la frappe suivante prolonge quand même.
    editor.type('mondx')
    editor.backspace()
    editor.type('e')
    await vi.advanceTimersByTimeAsync(150)
    expect(transport.calls).toEqual(['create replace «world»→«monde»'])
    expect(accepted(text, transport)).toBe('Hello monde!')
  })

  it('keeps one replacement when the word shares its end with the original', async () => {
    const { text, transport, editor } = setup()
    editor.select(6, 11)
    editor.type('words')
    await vi.advanceTimersByTimeAsync(150)
    expect(transport.calls).toEqual(['create replace «ld»→«ds»'])
    expect(accepted(text, transport)).toBe('Hello words!')
  })

  it('starts a new suggestion elsewhere and saves the previous one as is', async () => {
    const { text, transport, recorder, editor } = setup()
    editor.place(5)
    editor.type('!')
    editor.place(0)
    editor.type('¡')
    expect(recorder.drafts()).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(150)
    expect(transport.calls).toEqual(['create insert «»→«!»', 'create insert «»→«¡»'])
    expect(recorder.drafts()).toHaveLength(1)
    expect(accepted(text, transport)).toBe('¡Hello! world!')
  })

  it('removes a saved suggestion whose keystrokes cancel out', async () => {
    const { transport, hooks, recorder, editor } = setup()
    editor.place(5)
    editor.type('ab')
    await vi.advanceTimersByTimeAsync(150)
    editor.backspace(2)
    expect(editor.head).toBe(5)
    await vi.advanceTimersByTimeAsync(150)
    expect(transport.calls).toEqual(['create insert «»→«ab»', 'remove'])
    expect(hooks.onRemoved).toHaveBeenCalledTimes(1)
    expect(recorder.drafts()).toEqual([])
  })

  it('cancels the current suggestion (Ctrl+Z) even while its creation is in flight', async () => {
    const { transport, recorder, editor } = setup()
    editor.place(5)
    editor.type('x')
    await vi.advanceTimersByTimeAsync(100)
    expect(recorder.cancel()).toBe(true)
    await vi.advanceTimersByTimeAsync(10)
    expect(transport.calls).toEqual(['create insert «»→«x»', 'remove'])
    expect(transport.stored.size).toBe(0)
    expect(recorder.cancel()).toBe(false)
  })

  it('drops the draft when the API refuses it', async () => {
    const { transport, hooks, recorder, editor } = setup()
    transport.failNext = new Error('already decided')
    editor.place(5)
    editor.type('x')
    await vi.advanceTimersByTimeAsync(150)
    expect(hooks.onError).toHaveBeenCalledTimes(1)
    expect(recorder.drafts()).toEqual([])
    // La frappe suivante commence une nouvelle suggestion.
    editor.type('y')
    await vi.advanceTimersByTimeAsync(150)
    expect(transport.calls).toEqual(['create insert «»→«y»'])
  })

  it('forgets the draft of a suggestion decided or withdrawn elsewhere', async () => {
    const { transport, hooks, recorder, editor } = setup()
    editor.place(5)
    editor.type('ab')
    await vi.advanceTimersByTimeAsync(150)
    const [id] = transport.stored.keys()
    if (id === undefined) throw new Error('nothing stored')
    expect(recorder.drafts()).toEqual([expect.objectContaining({ id })])
    // Refusée par un éditeur (ou retirée depuis le panneau) : brouillon oublié, rien n'est envoyé.
    expect(recorder.discard(id)).toBe(true)
    expect(recorder.drafts()).toEqual([])
    expect(recorder.discard(id)).toBe(false)
    // La frappe suivante, au même endroit, commence une nouvelle suggestion.
    editor.type('c')
    await vi.advanceTimersByTimeAsync(150)
    expect(transport.calls).toEqual(['create insert «»→«ab»', 'create insert «»→«c»'])
    expect(hooks.onError).not.toHaveBeenCalled()
  })

  it('stays silent when a change in flight fails because the suggestion was decided', async () => {
    const { transport, hooks, recorder, editor } = setup()
    editor.place(5)
    editor.type('a')
    await vi.advanceTimersByTimeAsync(150)
    const [id] = transport.stored.keys()
    if (id === undefined) throw new Error('nothing stored')
    let release: () => void = () => undefined
    transport.hold = new Promise<void>((resolve) => {
      release = resolve
    })
    transport.failNext = new Error('already decided')
    editor.type('b')
    await vi.advanceTimersByTimeAsync(150)
    // Modification partie, puis la décision arrive : l'échec (409) n'est pas signalé.
    expect(recorder.discard(id)).toBe(true)
    release()
    await vi.advanceTimersByTimeAsync(10)
    expect(transport.calls).toEqual(['create insert «»→«a»'])
    expect(hooks.onError).not.toHaveBeenCalled()
    expect(recorder.drafts()).toEqual([])
  })

  it('refuses a keystroke that would make the suggestion too long', () => {
    const { hooks, recorder } = setup()
    expect(recorder.edit({ from: 0, to: 0, insert: 'x'.repeat(20_001), cursor: 0 })).toBeNull()
    expect(hooks.onRejected).toHaveBeenCalledTimes(1)
    expect(recorder.drafts()).toEqual([])
  })

  it('flushes the current suggestion when the mode changes', async () => {
    const { text, transport, recorder, editor } = setup()
    editor.place(12)
    editor.type(' Bye.')
    const flushed = recorder.flush()
    await vi.advanceTimersByTimeAsync(0)
    await flushed
    expect(transport.calls).toEqual(['create insert «»→« Bye.»'])
    expect(recorder.drafts()).toEqual([])
    const [stored] = transport.stored.values()
    if (stored === undefined) throw new Error('nothing stored')
    expect(resolveSuggestion(text, stored)).toEqual({ status: 'open', from: 12, to: 12 })
  })
})
