import * as Y from 'yjs'
import { describe, expect, it } from 'vitest'
import {
  type AttributedUpdate,
  createDocumentState,
  minimalReplacement,
  readDocumentText,
  replaceStateText,
  replayWithAttribution,
  TEXT_FIELD,
  textAfter,
  textBefore,
} from './index.js'

const ADA = '0b9f8d3e-5a4c-4b1e-9f2a-3c4d5e6f7a8b'
const BOB = '6f1c2d3e-4b5a-4c7d-8e9f-0a1b2c3d4e5f'

/** Deux éditeurs synchronisés ; chaque mise à jour est journalisée avec son auteur. */
function session(initial: string) {
  const base = createDocumentState(initial)
  const log: AttributedUpdate[] = []
  const docs = new Map<string, Y.Doc>()
  for (const author of [ADA, BOB]) {
    const doc = new Y.Doc()
    Y.applyUpdate(doc, base)
    doc.on('update', (update: Uint8Array, origin: unknown) => {
      if (origin === 'remote') return
      log.push({ authorId: author, update })
      for (const [other, otherDoc] of docs) {
        if (other !== author) Y.applyUpdate(otherDoc, update, 'remote')
      }
    })
    docs.set(author, doc)
  }
  const edit = (author: string, change: (text: Y.Text) => void) => {
    const doc = docs.get(author)
    if (!doc) throw new Error(`unknown author ${author}`)
    doc.transact(() => {
      change(doc.getText(TEXT_FIELD))
    })
  }
  const text = () => docs.get(ADA)?.getText(TEXT_FIELD).toJSON()
  return { base, log, edit, text }
}

describe('replayWithAttribution', () => {
  it('attributes every insertion and deletion to the update that made it', () => {
    const { base, log, edit, text } = session('Bonjour le monde')
    edit(ADA, (field) => {
      field.insert(7, ' tout')
    })
    edit(BOB, (field) => {
      field.delete(15, 6)
    })
    edit(BOB, (field) => {
      field.insert(field.length, ' entier')
    })
    edit(ADA, (field) => {
      field.insert(0, '« ')
    })

    const result = replayWithAttribution([base], log)
    expect(result.previousText).toBe('Bonjour le monde')
    expect(result.text).toBe(text())
    expect(result.segments).toEqual([
      { op: 'insert', text: '« ', authorId: ADA },
      { op: 'equal', text: 'Bonjour', authorId: null },
      { op: 'insert', text: ' tout', authorId: ADA },
      { op: 'equal', text: ' le', authorId: null },
      { op: 'delete', text: ' monde', authorId: BOB },
      { op: 'insert', text: ' entier', authorId: BOB },
    ])
    expect(textAfter(result.segments)).toBe(result.text)
    expect(textBefore(result.segments)).toBe(result.previousText)
  })

  it('drops text inserted and deleted within the window, and keeps the other author', () => {
    const { base, log, edit } = session('abc')
    edit(ADA, (field) => {
      field.insert(3, 'XYZ')
    })
    edit(BOB, (field) => {
      field.delete(3, 2)
    })
    const result = replayWithAttribution([base], log)
    expect(result.text).toBe('abcZ')
    expect(result.segments).toEqual([
      { op: 'equal', text: 'abc', authorId: null },
      { op: 'insert', text: 'Z', authorId: ADA },
    ])
  })

  it('keeps each author when the log holds an update before the one it depends on', () => {
    const { base, log, edit, text } = session('abc')
    edit(ADA, (field) => {
      field.insert(3, ' Ada')
    })
    // Bob modifie le texte d'Ada : sa mise à jour dépend de celle d'Ada.
    edit(BOB, (field) => {
      field.insert(field.length, ' Bob')
      field.delete(4, 3)
    })
    const [ada, bob] = log
    if (!ada || !bob) throw new Error('missing updates')
    // Deux instances temps réel : le lot de Bob est écrit avant celui d'Ada.
    const result = replayWithAttribution([base], [bob, ada])
    expect(result.text).toBe(text())
    expect(result.segments).toEqual([
      { op: 'equal', text: 'abc', authorId: null },
      { op: 'insert', text: ' ', authorId: ADA },
      { op: 'insert', text: ' Bob', authorId: BOB },
    ])
  })

  it('starts the next window from the returned state', () => {
    const { base, log, edit } = session('un')
    edit(ADA, (field) => {
      field.insert(2, ' deux')
    })
    const first = replayWithAttribution([base], log.splice(0))
    edit(BOB, (field) => {
      field.insert(field.length, ' trois')
    })
    const second = replayWithAttribution([first.state], log)
    expect(second.previousText).toBe('un deux')
    expect(second.segments).toEqual([
      { op: 'equal', text: 'un deux', authorId: null },
      { op: 'insert', text: ' trois', authorId: BOB },
    ])
  })

  it('catches up with the stored state when the log missed an update', () => {
    const { base, log, edit } = session('début')
    edit(ADA, (field) => {
      field.insert(5, ' A')
    })
    edit(BOB, (field) => {
      field.insert(7, ' B')
    })
    const stored = Y.mergeUpdates([base, ...log.map((entry) => entry.update)])
    // Mise à jour de Bob perdue par le journal : rattrapée sans auteur.
    const result = replayWithAttribution([base], log.slice(0, 1), stored)
    expect(result.text).toBe('début A B')
    expect(result.segments).toEqual([
      { op: 'equal', text: 'début', authorId: null },
      { op: 'insert', text: ' A', authorId: ADA },
      { op: 'insert', text: ' B', authorId: null },
    ])
  })

  it('treats a document without base as entirely inserted', () => {
    const initial = createDocumentState('\\documentclass{article}')
    const result = replayWithAttribution([], [{ authorId: ADA, update: initial }])
    expect(result.previousText).toBe('')
    expect(result.segments).toEqual([
      { op: 'insert', text: '\\documentclass{article}', authorId: ADA },
    ])
  })
})

describe('minimal replacement', () => {
  it('keeps the common prefix and suffix', () => {
    expect(minimalReplacement('abcdef', 'abXYef')).toEqual({
      from: 2,
      deleteCount: 2,
      insert: 'XY',
    })
    expect(minimalReplacement('same', 'same')).toBeNull()
    expect(minimalReplacement('', 'new')).toEqual({ from: 0, deleteCount: 0, insert: 'new' })
  })

  it('never splits a surrogate pair', () => {
    const change = minimalReplacement('a😀b', 'a😃b')
    expect(change).toEqual({ from: 1, deleteCount: 2, insert: '😃' })
  })

  it('replaces the text of a stored state and returns the update', () => {
    const state = createDocumentState('Bonjour le monde')
    const { state: next, update } = replaceStateText(state, 'Bonjour à tous')
    expect(readDocumentText(next)).toBe('Bonjour à tous')
    if (!update) throw new Error('expected an update')
    const doc = new Y.Doc()
    Y.applyUpdate(doc, state)
    Y.applyUpdate(doc, update)
    expect(doc.getText(TEXT_FIELD).toJSON()).toBe('Bonjour à tous')
    expect(replaceStateText(next, 'Bonjour à tous').update).toBeNull()
  })
})
