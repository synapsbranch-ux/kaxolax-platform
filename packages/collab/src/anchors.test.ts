import * as Y from 'yjs'
import { describe, expect, it } from 'vitest'
import {
  anchorFromBase64,
  anchorToBase64,
  createCommentAnchor,
  decodeCommentAnchor,
  resolveCommentAnchor,
} from './anchors.js'
import { TEXT_FIELD } from './index.js'

/** Document de deux clients synchronisés (mises à jour échangées dans les deux sens). */
function pair(initial: string) {
  const a = new Y.Doc()
  const b = new Y.Doc()
  a.on('update', (update: Uint8Array) => {
    Y.applyUpdate(b, update)
  })
  b.on('update', (update: Uint8Array) => {
    Y.applyUpdate(a, update)
  })
  a.getText(TEXT_FIELD).insert(0, initial)
  return { a: a.getText(TEXT_FIELD), b: b.getText(TEXT_FIELD) }
}

function anchored(text: Y.Text, anchor: Uint8Array): string | null {
  const resolved = resolveCommentAnchor(text, anchor)
  return resolved.status === 'attached'
    ? text.toJSON().slice(resolved.from, resolved.to)
    : resolved.status
}

describe('comment anchors', () => {
  const initial = 'Bonjour le monde entier.'
  const target = 'le monde'
  const from = initial.indexOf(target)
  const to = from + target.length

  it('resolves to the original range', () => {
    const text = new Y.Doc().getText(TEXT_FIELD)
    text.insert(0, initial)
    const anchor = createCommentAnchor(text, from, to)
    expect(resolveCommentAnchor(text, anchor)).toEqual({ status: 'attached', from, to })
  })

  it('follows insertions before, inside and after the range, made by another client', () => {
    const { a, b } = pair(initial)
    const anchor = createCommentAnchor(a, from, to)
    b.insert(0, 'Oh. ') // avant
    expect(anchored(a, anchor)).toBe('le monde')
    b.insert(b.toJSON().indexOf('monde'), 'vaste ') // dedans
    expect(anchored(a, anchor)).toBe('le vaste monde')
    b.insert(b.toJSON().indexOf(' entier'), ' et') // juste après
    expect(anchored(a, anchor)).toBe('le vaste monde')
    expect(anchored(b, anchor)).toBe('le vaste monde')
  })

  it('does not grow when text is typed exactly at its boundaries', () => {
    const { a } = pair(initial)
    const anchor = createCommentAnchor(a, from, to)
    a.insert(from, 'X')
    const resolved = resolveCommentAnchor(a, anchor)
    expect(anchored(a, anchor)).toBe('le monde')
    if (resolved.status !== 'attached') throw new Error('detached')
    a.insert(resolved.to, 'Y')
    expect(anchored(a, anchor)).toBe('le monde')
    expect(a.toJSON()).toBe('Bonjour Xle mondeY entier.')
  })

  it('shrinks on a partial deletion, at either end', () => {
    const { a, b } = pair(initial)
    const anchor = createCommentAnchor(a, from, to)
    // « jour le » : début de la plage supprimé avec le texte qui la précède.
    b.delete(initial.indexOf('jour'), 'jour le'.length)
    expect(anchored(a, anchor)).toBe(' monde')
    // « nde ent » : fin de la plage supprimée avec le texte qui la suit.
    b.delete(b.toJSON().indexOf('nde'), 'nde ent'.length)
    expect(anchored(a, anchor)).toBe(' mo')
  })

  it('is detached when the whole anchored text is deleted, and survives a reload', () => {
    const { a, b } = pair(initial)
    const anchor = createCommentAnchor(a, from, to)
    b.delete(from - 1, target.length + 2)
    expect(resolveCommentAnchor(a, anchor)).toEqual({ status: 'detached', at: from - 1 })
    // Document rechargé depuis l'état persisté (contenu supprimé ramassé par le GC).
    const reloaded = new Y.Doc()
    Y.applyUpdate(reloaded, Y.encodeStateAsUpdate(b.doc ?? new Y.Doc()))
    expect(resolveCommentAnchor(reloaded.getText(TEXT_FIELD), anchor).status).toBe('detached')
  })

  it('is attached again when the deletion is undone', () => {
    const doc = new Y.Doc()
    const text = doc.getText(TEXT_FIELD)
    text.insert(0, initial)
    const anchor = createCommentAnchor(text, from, to)
    const undo = new Y.UndoManager(text)
    text.delete(from, target.length)
    expect(resolveCommentAnchor(text, anchor).status).toBe('detached')
    undo.undo()
    expect(anchored(text, anchor)).toBe('le monde')
  })

  it('anchors the whole text and its last character', () => {
    const text = new Y.Doc().getText(TEXT_FIELD)
    text.insert(0, 'abc')
    const anchor = createCommentAnchor(text, 0, 3)
    text.insert(3, 'd')
    text.insert(0, 'z')
    expect(anchored(text, anchor)).toBe('abc')
  })

  it('is unknown in a document that has not received the anchored text', () => {
    const text = new Y.Doc().getText(TEXT_FIELD)
    text.insert(0, initial)
    const anchor = createCommentAnchor(text, from, to)
    const other = new Y.Doc().getText(TEXT_FIELD)
    other.insert(0, initial)
    expect(resolveCommentAnchor(other, anchor)).toEqual({ status: 'unknown' })
  })

  it('rejects empty or out-of-range selections', () => {
    const text = new Y.Doc().getText(TEXT_FIELD)
    text.insert(0, 'abc')
    expect(() => createCommentAnchor(text, 1, 1)).toThrow(RangeError)
    expect(() => createCommentAnchor(text, 2, 4)).toThrow(RangeError)
    expect(() => createCommentAnchor(text, -1, 2)).toThrow(RangeError)
  })

  it('round-trips through base64 and rejects malformed anchors', () => {
    const text = new Y.Doc().getText(TEXT_FIELD)
    text.insert(0, initial)
    const anchor = createCommentAnchor(text, from, to)
    const decoded = anchorFromBase64(anchorToBase64(anchor))
    expect(decoded).toEqual(anchor)
    expect(decodeCommentAnchor(anchor)).not.toBeNull()
    expect(anchorFromBase64('pas du base64!')).toBeNull()
    expect(decodeCommentAnchor(new Uint8Array([2, 0, 0, 0, 1, 0, 0]))).toBeNull()
    expect(decodeCommentAnchor(new Uint8Array([1, 0, 0, 0, 40, 1, 2]))).toBeNull()
    expect(decodeCommentAnchor(new Uint8Array([1, 0, 0, 0, 1, 255, 255, 255]))).toBeNull()
    expect(decodeCommentAnchor(new Uint8Array(1000))).toBeNull()
  })
})

describe('createStateAnchor', () => {
  it('anchors a range of a persisted state', async () => {
    const { createDocumentState, createStateAnchor } = await import('./index.js')
    const state = createDocumentState('Bonjour le monde')
    const doc = new Y.Doc()
    Y.applyUpdate(doc, state)
    const text = doc.getText(TEXT_FIELD)
    const anchor = createStateAnchor(state, 8, 10)
    text.insert(0, '« ')
    expect(anchored(text, anchor)).toBe('le')
  })
})
