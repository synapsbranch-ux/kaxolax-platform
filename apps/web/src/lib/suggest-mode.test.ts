// @vitest-environment happy-dom
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { applySuggestion, resolveSuggestion, TEXT_FIELD } from '@kaxolax/collab'
import type { CreateSuggestionInput, Suggestion } from '@kaxolax/contracts'
import {
  createDefaultRegistry,
  setSuggestionMarks,
  setSuggestMode,
  type SuggestionMark,
  suggestionMarks,
  suggestionTracking,
} from '@kaxolax/editor'
import { afterEach, describe, expect, it } from 'vitest'
import { yCollab, ySyncAnnotation } from 'y-codemirror.next'
import * as Y from 'yjs'
import { SuggestionRecorder } from './suggestion-recorder'
import { actionsReadOnly, effectiveEditMode } from './suggestions'

/**
 * Mode Suggérer de bout en bout dans le navigateur (sans réseau) : éditeur CodeMirror relié au
 * texte Yjs par y-codemirror, frappes interceptées, enregistreur et faux service ; le texte
 * partagé ne change qu'à l'acceptation, appliquée par un autre client (le service temps réel).
 */

const AUTHOR = '00000000-0000-4000-8000-000000000001'
const DOCUMENT = '00000000-0000-4000-8000-0000000000d0'

const cleanups: (() => void)[] = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
})

/** Deux clients synchronisés : le navigateur (éditeur) et le service temps réel. */
function setup(content: string) {
  const browser = new Y.Doc()
  const server = new Y.Doc()
  browser.on('update', (update: Uint8Array, origin: unknown) => {
    if (origin !== 'server') Y.applyUpdate(server, update, 'browser')
  })
  server.on('update', (update: Uint8Array, origin: unknown) => {
    if (origin !== 'browser') Y.applyUpdate(browser, update, 'server')
  })
  server.getText(TEXT_FIELD).insert(0, content)
  const ytext = browser.getText(TEXT_FIELD)
  const stored: { id: string; input: CreateSuggestionInput }[] = []
  let refresh: () => void = () => undefined
  const recorder = new SuggestionRecorder(
    ytext,
    DOCUMENT,
    AUTHOR,
    {
      create: (input) => {
        const id = `00000000-0000-4000-8000-${String(stored.length + 1).padStart(12, '0')}`
        stored.push({ id, input })
        return Promise.resolve({ id } as Suggestion)
      },
      update: (id, input) => {
        const entry = stored.find((candidate) => candidate.id === id)
        if (entry) entry.input = { ...entry.input, ...input }
        return Promise.resolve({ id } as Suggestion)
      },
      remove: () => Promise.resolve(),
    },
    {
      onSaved: () => undefined,
      onRemoved: () => undefined,
      onError: () => undefined,
      onRejected: () => undefined,
      onChange: () => {
        refresh()
      },
    },
    0,
  )
  const view = new EditorView({
    parent: document.body,
    state: EditorState.create({
      doc: ytext.toJSON(),
      extensions: [
        yCollab(ytext, null),
        suggestionTracking({
          isRemote: (transaction) => transaction.annotation(ySyncAnnotation) !== undefined,
          onEdit: (edit) => {
            const cursor = recorder.edit(edit)
            queueMicrotask(() => {
              if (cursor !== null) view.dispatch({ selection: { anchor: cursor } })
            })
          },
          canDecide: () => true,
        }),
      ],
    }),
  })
  // Affichage des brouillons, comme la page projet.
  refresh = () => {
    queueMicrotask(() => {
      const marks: SuggestionMark[] = recorder.drafts().flatMap((draft, index) => {
        const position = resolveSuggestion(ytext, draft.pending)
        if (position.status !== 'open') return []
        return [
          {
            id: `draft-${String(index)}`,
            kind: draft.pending.kind,
            from: position.from,
            to: position.to,
            proposedText: draft.pending.proposedText,
            authorName: 'Grace Hopper',
            color: 'var(--presence-2)',
            dateLabel: null,
            mine: true,
            draft: true,
          },
        ]
      })
      view.dispatch({ effects: setSuggestionMarks.of(marks) })
    })
  }
  view.dispatch({ effects: setSuggestMode.of(true) })
  cleanups.push(() => {
    view.destroy()
    browser.destroy()
    server.destroy()
  })
  /** Frappe au curseur (remplace la sélection), comme une saisie au clavier. */
  const type = async (text: string) => {
    for (const character of text) {
      const { from, to } = view.state.selection.main
      view.dispatch({
        changes: { from, to, insert: character },
        selection: { anchor: from + 1 },
        userEvent: 'input.type',
      })
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
  }
  return { view, ytext, server, recorder, stored, type }
}

describe('suggest mode in the editor', () => {
  it('records keystrokes as a suggestion without touching the shared text', async () => {
    const { view, ytext, server, recorder, stored, type } = setup('Hello world!')
    view.dispatch({ selection: { anchor: 5 } })
    await type(', dear')
    expect(ytext.toJSON()).toBe('Hello world!')
    expect(server.getText(TEXT_FIELD).toJSON()).toBe('Hello world!')
    expect(view.state.doc.toString()).toBe('Hello world!')
    // Le texte proposé est affiché en widget, à la couleur de l'auteur.
    expect(view.contentDOM.querySelector('.cm-suggestion-insert')?.textContent).toBe(', dear')
    await recorder.flush()
    expect(stored.map((entry) => entry.input.proposedText)).toEqual([', dear'])
  })

  it('applies the accepted suggestion through the realtime document only', async () => {
    const { view, ytext, server, recorder, stored, type } = setup('Hello world!')
    view.dispatch({ selection: { anchor: 6, head: 11 } })
    await type('monde')
    await recorder.flush()
    const [entry] = stored
    if (entry === undefined) throw new Error('no suggestion stored')
    expect(entry.input).toMatchObject({
      kind: 'replace',
      originalText: 'world',
      proposedText: 'monde',
    })
    // Le service temps réel applique la suggestion acceptée : l'éditeur la reçoit (mise à jour
    // distante, pas interceptée).
    applySuggestion(
      server.getText(TEXT_FIELD),
      { id: entry.id, ...entry.input },
      {
        decidedBy: AUTHOR,
      },
    )
    expect(ytext.toJSON()).toBe('Hello monde!')
    expect(view.state.doc.toString()).toBe('Hello monde!')
  })

  it('maps the displayed suggestions through remote edits', async () => {
    const { view, server, type } = setup('Hello world!')
    view.dispatch({ selection: { anchor: 12 } })
    await type('!')
    server.getText(TEXT_FIELD).insert(0, '>> ')
    expect(view.state.doc.toString()).toBe('>> Hello world!')
    expect(suggestionMarks(view.state)[0]).toMatchObject({ from: 15, to: 15, proposedText: '!' })
  })

  it('lets a reviewer use the Tools actions, which become suggestions', async () => {
    const { view, ytext, recorder, stored } = setup('Soit x un réel.')
    const registry = createDefaultRegistry()
    const opened: string[] = []
    const host = (mode: ReturnType<typeof effectiveEditMode>) => ({
      readOnly: actionsReadOnly(false, mode),
      openDialog: (id: string) => {
        opened.push(id)
      },
    })
    // Lecteur : aucun mode, outils désactivés.
    expect(
      registry.isEnabled('math.inline', { view, host: host(effectiveEditMode('viewer', null)) }),
    ).toBe(false)
    // Relecteur : toujours en Suggérer, outils disponibles.
    const context = { view, host: host(effectiveEditMode('reviewer', null)) }
    expect(context.host.readOnly).toBe(false)
    expect(registry.isEnabled('math.symbols', context)).toBe(true)
    expect(registry.run('math.symbols', context)).toBe(true)
    expect(opened).toEqual(['math.symbols'])
    view.dispatch({ selection: { anchor: 5, head: 6 } })
    expect(registry.isEnabled('math.inline', context)).toBe(true)
    expect(registry.run('math.inline', context)).toBe(true)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(ytext.toJSON()).toBe('Soit x un réel.')
    await recorder.flush()
    expect(stored).toHaveLength(1)
    expect(stored[0]?.input).toMatchObject({ originalText: 'x', proposedText: '\\(x\\)' })
  })

  it('lets edits through once the mode is off', () => {
    const { view, ytext } = setup('Hello')
    view.dispatch({ effects: setSuggestMode.of(false) })
    view.dispatch({ changes: { from: 5, insert: '!' }, userEvent: 'input.type' })
    expect(ytext.toJSON()).toBe('Hello!')
  })
})
