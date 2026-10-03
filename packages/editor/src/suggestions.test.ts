// @vitest-environment happy-dom
import { Annotation, EditorState, type Transaction } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  type InterceptedEdit,
  isSuggesting,
  setActiveSuggestion,
  setSuggestionMarks,
  setSuggestMode,
  type SuggestionExtensionOptions,
  type SuggestionMark,
  suggestionMarks,
  suggestionsAt,
  suggestionTracking,
  suggestionViewEdit,
} from './index.js'

/** Annotation des transactions « distantes » des tests (mises à jour Yjs reçues). */
const remote = Annotation.define<boolean>()

const views: EditorView[] = []
afterEach(() => {
  for (const view of views.splice(0)) view.destroy()
})

function mark(overrides: Partial<SuggestionMark> = {}): SuggestionMark {
  return {
    id: 's1',
    kind: 'replace',
    from: 6,
    to: 11,
    proposedText: 'monde',
    authorName: 'Grace Hopper',
    color: 'var(--presence-2)',
    dateLabel: '3 oct., 10:00',
    mine: false,
    draft: false,
    ...overrides,
  }
}

function editor(options: Partial<SuggestionExtensionOptions> = {}, doc = 'Hello world!') {
  const edits: InterceptedEdit[] = []
  const view = new EditorView({
    state: EditorState.create({
      doc,
      extensions: suggestionTracking({
        isRemote: (transaction: Transaction) => transaction.annotation(remote) === true,
        onEdit: (edit) => edits.push(edit),
        canDecide: () => true,
        ...options,
      }),
    }),
    parent: document.body,
  })
  views.push(view)
  return { view, edits }
}

describe('suggest mode', () => {
  it('lets edits through until the mode is on', () => {
    const { view, edits } = editor()
    expect(isSuggesting(view.state)).toBe(false)
    view.dispatch({ changes: { from: 0, insert: 'Oh, ' }, userEvent: 'input.type' })
    expect(view.state.doc.toString()).toBe('Oh, Hello world!')
    expect(edits).toEqual([])
  })

  it('intercepts local edits: the text stays, the edit is reported', () => {
    const { view, edits } = editor()
    view.dispatch({ effects: setSuggestMode.of(true) })
    view.dispatch({
      changes: { from: 5, insert: ',' },
      selection: { anchor: 6 },
      userEvent: 'input.type',
    })
    expect(view.state.doc.toString()).toBe('Hello world!')
    expect(edits).toEqual([{ from: 5, to: 5, insert: ',', cursor: 5 }])
    // Le curseur reste au point d'insertion, après le texte proposé (widget).
    expect(view.state.selection.main.head).toBe(5)

    // Remplacement d'une sélection : curseur à la fin du texte barré.
    view.dispatch({ changes: { from: 6, to: 11, insert: 'there' }, userEvent: 'input.paste' })
    expect(edits.at(-1)).toEqual({ from: 6, to: 11, insert: 'there', cursor: 11 })
    expect(view.state.selection.main.head).toBe(11)
  })

  it('places the cursor before a backward deletion and after a forward one', () => {
    const { view, edits } = editor()
    view.dispatch({ effects: setSuggestMode.of(true) })
    view.dispatch({ changes: { from: 4, to: 5 }, userEvent: 'delete.backward' })
    expect(view.state.selection.main.head).toBe(4)
    view.dispatch({ changes: { from: 6, to: 7 }, userEvent: 'delete.forward' })
    expect(view.state.selection.main.head).toBe(7)
    expect(edits).toEqual([
      { from: 4, to: 5, insert: '', cursor: 4 },
      { from: 6, to: 7, insert: '', cursor: 7 },
    ])
  })

  it('covers several changes of one transaction with a single edit', () => {
    const { view, edits } = editor()
    view.dispatch({ effects: setSuggestMode.of(true) })
    view.dispatch({
      changes: [
        { from: 0, to: 1, insert: 'J' },
        { from: 6, to: 7, insert: 'W' },
      ],
      userEvent: 'input.action',
    })
    expect(edits).toEqual([{ from: 0, to: 7, insert: 'Jello W', cursor: 7 }])
    expect(view.state.doc.toString()).toBe('Hello world!')
  })

  it('never intercepts remote updates', () => {
    const { view, edits } = editor()
    view.dispatch({ effects: setSuggestMode.of(true) })
    view.dispatch({ changes: { from: 0, insert: '¡' }, annotations: remote.of(true) })
    expect(view.state.doc.toString()).toBe('¡Hello world!')
    expect(edits).toEqual([])
  })

  it('turns undo into « cancel the current suggestion »', () => {
    const onUndo = vi.fn()
    const { view } = editor({ onUndo })
    const ctrlZ = () =>
      view.contentDOM.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true, cancelable: true }),
      )
    ctrlZ()
    expect(onUndo).not.toHaveBeenCalled()
    view.dispatch({ effects: setSuggestMode.of(true) })
    ctrlZ()
    expect(onUndo).toHaveBeenCalledTimes(1)
  })

  it('swallows redo in Suggest mode without cancelling the current suggestion', () => {
    const onUndo = vi.fn()
    const { view } = editor({ onUndo })
    const press = (init: KeyboardEventInit) =>
      view.contentDOM.dispatchEvent(
        new KeyboardEvent('keydown', { ctrlKey: true, bubbles: true, cancelable: true, ...init }),
      )
    view.dispatch({ effects: setSuggestMode.of(true) })
    const before = view.state.doc.toString()
    const redo = new KeyboardEvent('keydown', {
      key: 'y',
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    })
    view.contentDOM.dispatchEvent(redo)
    expect(redo.defaultPrevented).toBe(true)
    press({ key: 'Z', shiftKey: true })
    expect(onUndo).not.toHaveBeenCalled()
    expect(view.state.doc.toString()).toBe(before)
  })
})

describe('inline display', () => {
  it('strikes the original text and shows the proposed text in the author colour', () => {
    const { view } = editor()
    view.dispatch({ effects: setSuggestionMarks.of([mark()]) })
    const deleted = view.contentDOM.querySelector('.cm-suggestion-delete')
    const inserted = view.contentDOM.querySelector('.cm-suggestion-insert')
    expect(deleted?.textContent).toBe('world')
    expect(deleted?.getAttribute('style')).toContain('var(--presence-2)')
    expect(inserted?.textContent).toBe('monde')
    expect(inserted?.getAttribute('title')).toBe('Ajout suggéré par Grace Hopper')
    // Le texte ajouté n'est pas dans le texte barré (il ne serait pas lisible).
    expect(deleted?.contains(inserted ?? null)).toBe(false)
    // Le texte du document ne change pas.
    expect(view.state.doc.toString()).toBe('Hello world!')
  })

  it('highlights the active suggestion', () => {
    const { view } = editor()
    view.dispatch({
      effects: [
        setSuggestionMarks.of([mark(), mark({ id: 's2', kind: 'insert', from: 0, to: 0 })]),
        setActiveSuggestion.of('s2'),
      ],
    })
    const active = view.contentDOM.querySelectorAll('.cm-suggestion-active')
    expect(active).toHaveLength(1)
    expect((active[0] as HTMLElement).dataset.suggestionId).toBe('s2')
  })

  it('drops invalid marks and maps the others through remote changes', () => {
    const { view } = editor()
    view.dispatch({
      effects: setSuggestionMarks.of([
        mark(),
        mark({ id: 'bad-insert', kind: 'insert', from: 1, to: 3 }),
        mark({ id: 'outside', from: 40, to: 50 }),
      ]),
    })
    expect(suggestionMarks(view.state).map((candidate) => candidate.id)).toEqual(['s1'])
    view.dispatch({ changes: { from: 0, insert: '>> ' }, annotations: remote.of(true) })
    expect(suggestionMarks(view.state)[0]).toMatchObject({ from: 9, to: 14 })
    // Texte d'origine entièrement supprimé : la suggestion disparaît de l'affichage.
    view.dispatch({ changes: { from: 9, to: 14 }, annotations: remote.of(true) })
    expect(suggestionMarks(view.state)).toEqual([])
  })

  it('finds the decided suggestions under a position, drafts excluded', () => {
    const { view } = editor()
    view.dispatch({
      effects: setSuggestionMarks.of([
        mark(),
        mark({ id: 'point', kind: 'insert', from: 8, to: 8, proposedText: 'x' }),
        mark({ id: 'draft', from: 6, to: 8, draft: true }),
      ]),
    })
    expect(suggestionsAt(view.state, 8).map((candidate) => candidate.id)).toEqual(['point', 's1'])
    expect(suggestionsAt(view.state, 2)).toEqual([])
  })

  it('accepts and rejects the suggestion under the cursor from the keyboard', () => {
    const onAction = vi.fn()
    const { view } = editor({ onAction })
    view.dispatch({ effects: setSuggestionMarks.of([mark()]), selection: { anchor: 7 } })
    const press = (shiftKey: boolean) =>
      view.contentDOM.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Enter',
          ctrlKey: true,
          altKey: true,
          shiftKey,
          bubbles: true,
          cancelable: true,
        }),
      )
    press(false)
    press(true)
    expect(onAction.mock.calls).toEqual([
      ['s1', 'accept'],
      ['s1', 'reject'],
    ])
  })
})

describe('suggestionViewEdit', () => {
  it('keeps the coordinates without a current suggestion', () => {
    expect(suggestionViewEdit({ from: 2, to: 4, insert: 'x' }, null)).toEqual({
      from: 2,
      to: 4,
      insert: 'x',
    })
  })

  it('types after the proposed text of an insertion', () => {
    // « ab » proposé au point 5 : la frappe suivante au point 5 va après « ab ».
    const draft = { from: 5, to: 5, proposedLength: 2 }
    expect(suggestionViewEdit({ from: 5, to: 5, insert: 'c' }, draft)).toEqual({
      from: 7,
      to: 7,
      insert: 'c',
    })
    // Retour arrière : retire le dernier caractère proposé.
    expect(suggestionViewEdit({ from: 4, to: 5, insert: '' }, draft)).toEqual({
      from: 6,
      to: 7,
      insert: '',
    })
    // Avant la suggestion : rien ne bouge.
    expect(suggestionViewEdit({ from: 1, to: 2, insert: 'z' }, draft)).toEqual({
      from: 1,
      to: 2,
      insert: 'z',
    })
  })

  it('extends a deletion backwards and forwards', () => {
    // [4, 6[ barré, rien de proposé.
    const draft = { from: 4, to: 6, proposedLength: 0 }
    // Retour arrière avec le curseur avant le texte barré.
    expect(suggestionViewEdit({ from: 3, to: 4, insert: '' }, draft)).toEqual({
      from: 3,
      to: 4,
      insert: '',
    })
    // Retour arrière avec le curseur après le texte barré.
    expect(suggestionViewEdit({ from: 5, to: 6, insert: '' }, draft)).toEqual({
      from: 3,
      to: 4,
      insert: '',
    })
    // Suppression vers l'avant après le texte barré.
    expect(suggestionViewEdit({ from: 6, to: 7, insert: '' }, draft)).toEqual({
      from: 4,
      to: 5,
      insert: '',
    })
  })

  it('edits the proposed text of a replacement', () => {
    // « world » [6, 11[ remplacé par « monde » (5).
    const draft = { from: 6, to: 11, proposedLength: 5 }
    expect(suggestionViewEdit({ from: 10, to: 11, insert: '' }, draft)).toEqual({
      from: 10,
      to: 11,
      insert: '',
    })
    expect(suggestionViewEdit({ from: 11, to: 11, insert: 's' }, draft)).toEqual({
      from: 11,
      to: 11,
      insert: 's',
    })
    // Frappe dans le texte barré : après le texte proposé.
    expect(suggestionViewEdit({ from: 8, to: 8, insert: '!' }, draft)).toEqual({
      from: 11,
      to: 11,
      insert: '!',
    })
    // Sélection qui couvre la suggestion et le texte d'avant.
    expect(suggestionViewEdit({ from: 2, to: 11, insert: '' }, draft)).toEqual({
      from: 2,
      to: 11,
      insert: '',
    })
  })
})
