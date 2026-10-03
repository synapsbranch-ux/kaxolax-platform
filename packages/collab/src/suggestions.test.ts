import { SUGGESTION_TEXT_MAX_LENGTH } from '@kaxolax/contracts'
import * as Y from 'yjs'
import { describe, expect, it } from 'vitest'
import { anchorToBase64, createCommentAnchor, createPointAnchor, isPointAnchor } from './anchors.js'
import { TEXT_FIELD } from './index.js'
import {
  APPLIED_SUGGESTIONS_FIELD,
  applySuggestion,
  isSuggestionAnchorValid,
  type PendingSuggestion,
  pendingSuggestionInput,
  recordSuggestionEdit,
  resolveSuggestion,
  suggestionKindOf,
} from './suggestions.js'

const ADA = 'ada'
const BOB = 'bob'

function textOf(initial: string): Y.Text {
  const text = new Y.Doc().getText(TEXT_FIELD)
  text.insert(0, initial)
  return text
}

/** Deux clients synchronisés : le texte de l'auteur et celui d'un autre membre. */
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

/** Frappes successives (curseur de la vue) : renvoie la suggestion en cours et les terminées. */
function type(
  text: Y.Text,
  edits: { from: number; to?: number; insert?: string }[],
  authorId = ADA,
  start: PendingSuggestion | null = null,
) {
  let pending = start
  const finished: PendingSuggestion[] = []
  for (const edit of edits) {
    const result = recordSuggestionEdit(text, pending, authorId, {
      from: edit.from,
      to: edit.to ?? edit.from,
      insert: edit.insert ?? '',
    })
    if (result.finished) finished.push(result.finished)
    pending = result.pending
  }
  return { pending, finished }
}

/** Texte de la vue : la suggestion appliquée à une copie. */
function preview(text: Y.Text, pending: PendingSuggestion): string {
  const resolution = resolveSuggestion(text, pending)
  if (resolution.status !== 'open') throw new Error(`suggestion is ${resolution.status}`)
  const base = text.toJSON()
  return base.slice(0, resolution.from) + pending.proposedText + base.slice(resolution.to)
}

describe('suggestion kinds and anchors', () => {
  it('derives the kind from the texts', () => {
    expect(suggestionKindOf('', 'x')).toBe('insert')
    expect(suggestionKindOf('x', '')).toBe('delete')
    expect(suggestionKindOf('x', 'y')).toBe('replace')
    expect(suggestionKindOf('x', 'x')).toBeNull()
  })

  it('tells a point from a range', () => {
    const text = textOf('Bonjour')
    const point = createPointAnchor(text, 3)
    const range = createCommentAnchor(text, 3, 4)
    expect(isPointAnchor(point)).toBe(true)
    expect(isPointAnchor(range)).toBe(false)
    expect(isSuggestionAnchorValid('insert', point)).toBe(true)
    expect(isSuggestionAnchorValid('insert', range)).toBe(false)
    expect(isSuggestionAnchorValid('replace', range)).toBe(true)
    expect(isSuggestionAnchorValid('delete', point)).toBe(false)
    expect(isSuggestionAnchorValid('delete', new Uint8Array([1, 2, 3]))).toBe(false)
    expect(isPointAnchor(createPointAnchor(text, text.length))).toBe(true)
    expect(() => createPointAnchor(text, 99)).toThrow(RangeError)
  })
})

describe('recording edits in Suggest mode', () => {
  it('merges successive keystrokes of one author into one insertion', () => {
    const text = textOf('Le chat dort.')
    const at = 'Le chat'.length
    const { pending, finished } = type(text, [
      { from: at, insert: ' ' },
      { from: at + 1, insert: 'n' },
      { from: at + 2, insert: 'o' },
      { from: at + 3, insert: 'i' },
      { from: at + 4, insert: 'r' },
    ])
    expect(finished).toEqual([])
    expect(pending).toMatchObject({ kind: 'insert', originalText: '', proposedText: ' noir' })
    if (!pending) throw new Error('pending expected')
    expect(preview(text, pending)).toBe('Le chat noir dort.')
    // Le texte n'a pas changé.
    expect(text.toJSON()).toBe('Le chat dort.')
  })

  it('turns backspaces inside the suggestion into a shorter one, then cancels it', () => {
    const text = textOf('abc')
    const typed = type(text, [
      { from: 1, insert: 'x' },
      { from: 2, insert: 'y' },
    ])
    expect(typed.pending?.proposedText).toBe('xy')
    const back = recordSuggestionEdit(text, typed.pending, ADA, { from: 2, to: 3, insert: '' })
    expect(back.pending?.proposedText).toBe('x')
    const cancelled = recordSuggestionEdit(text, back.pending, ADA, { from: 1, to: 2, insert: '' })
    expect(cancelled).toMatchObject({ pending: null, finished: null, rejected: false })
    expect(cancelled.cancelled?.proposedText).toBe('x')
  })

  it('turns a deletion followed by typing into a replacement', () => {
    const text = textOf('Le chien dort.')
    const from = 'Le '.length
    const { pending } = type(text, [
      { from, to: from + 'chien'.length }, // sélection supprimée
      { from, insert: 'c' },
      { from: from + 1, insert: 'h' },
      { from: from + 2, insert: 'a' },
      { from: from + 3, insert: 't' },
    ])
    // Préfixe commun « ch » retiré : seule la partie changée est suggérée.
    expect(pending).toMatchObject({ kind: 'replace', originalText: 'ien', proposedText: 'at' })
    if (!pending) throw new Error('pending expected')
    expect(preview(text, pending)).toBe('Le chat dort.')
  })

  it('extends a deletion with successive backspaces and forward deletes', () => {
    const text = textOf('abcdef')
    const { pending } = type(text, [
      { from: 3, to: 4 }, // « d » (suppression vers l'avant)
      { from: 2, to: 3 }, // « c » (retour arrière)
      { from: 2, to: 3 }, // « e », de nouveau vers l'avant
    ])
    expect(pending).toMatchObject({ kind: 'delete', originalText: 'cde', proposedText: '' })
  })

  it('starts a new suggestion elsewhere, or for another author', () => {
    const text = textOf('un deux trois')
    const first = type(text, [{ from: 2, insert: '!' }])
    // Vue : « un! deux trois » ; frappe après « deux » (position 8 dans la vue, 7 dans le texte).
    const elsewhere = recordSuggestionEdit(text, first.pending, ADA, {
      from: 8,
      to: 8,
      insert: '?',
    })
    expect(elsewhere.finished?.proposedText).toBe('!')
    expect(elsewhere.pending).toMatchObject({ kind: 'insert', proposedText: '?' })
    if (!elsewhere.pending) throw new Error('pending expected')
    expect(preview(text, elsewhere.pending)).toBe('un deux? trois')

    const other = recordSuggestionEdit(text, first.pending, BOB, { from: 2, to: 2, insert: '#' })
    expect(other.finished?.authorId).toBe(ADA)
    expect(other.pending).toMatchObject({ authorId: BOB, proposedText: '#' })
  })

  it('keeps the id of a stored suggestion it extends', () => {
    const text = textOf('abc')
    const first = type(text, [{ from: 1, insert: 'x' }])
    if (!first.pending) throw new Error('pending expected')
    const stored = { ...first.pending, id: 'suggestion-1' }
    const next = recordSuggestionEdit(text, stored, ADA, { from: 2, to: 2, insert: 'y' })
    expect(next.pending).toMatchObject({ id: 'suggestion-1', proposedText: 'xy' })
    expect(pendingSuggestionInput(stored)).toEqual({
      kind: 'insert',
      anchor: anchorToBase64(stored.anchor),
      originalText: '',
      proposedText: 'x',
    })
  })

  it('finishes a suggestion whose text changed under it', () => {
    const { a, b } = pair('Le chien dort.')
    const typed = type(a, [{ from: 3, to: 8, insert: 'chat' }])
    expect(typed.pending?.kind).toBe('replace')
    b.delete(4, 1) // « chen »
    const next = recordSuggestionEdit(a, typed.pending, ADA, { from: 0, to: 0, insert: 'X' })
    expect(next.finished?.originalText).toBe('ien')
    expect(next.pending).toMatchObject({ proposedText: 'X' })
  })

  it('refuses text longer than the limit and rejects ranges outside the view', () => {
    const text = textOf('abc')
    const huge = 'x'.repeat(SUGGESTION_TEXT_MAX_LENGTH + 1)
    expect(recordSuggestionEdit(text, null, ADA, { from: 0, to: 0, insert: huge })).toMatchObject({
      pending: null,
      rejected: true,
    })
    const typed = type(text, [{ from: 0, insert: 'x'.repeat(SUGGESTION_TEXT_MAX_LENGTH) }])
    const more = recordSuggestionEdit(text, typed.pending, ADA, { from: 0, to: 0, insert: 'y' })
    expect(more.rejected).toBe(true)
    expect(more.pending).toBe(typed.pending)
    expect(() => recordSuggestionEdit(text, null, ADA, { from: 2, to: 9, insert: '' })).toThrow(
      RangeError,
    )
  })
})

describe('resolving suggestions after edits around them', () => {
  it('follows insertions before and after a replaced range', () => {
    const { a, b } = pair('Bonjour le monde.')
    const { pending } = type(a, [{ from: 11, to: 16, insert: 'ciel' }])
    expect(pending).toMatchObject({ kind: 'replace', originalText: 'monde' })
    if (!pending) throw new Error('pending expected')
    b.insert(0, 'Oh. ')
    b.insert(b.toJSON().indexOf('.', 10), ' entier')
    const resolved = resolveSuggestion(a, pending)
    expect(resolved).toEqual({ status: 'open', from: 15, to: 20 })
    expect(preview(a, pending)).toBe('Oh. Bonjour le ciel entier.')
  })

  it('keeps an insertion point in place when others type around it', () => {
    const { a, b } = pair('abcd')
    const { pending } = type(a, [{ from: 2, insert: 'X' }])
    if (!pending) throw new Error('pending expected')
    b.insert(0, '>>')
    b.insert(b.length, '<<')
    expect(preview(a, pending)).toBe('>>abXcd<<')
    // Le caractère qui suit le point disparaît : le point reste à sa place.
    b.delete(4, 1)
    expect(preview(a, pending)).toBe('>>abXd<<')
  })

  it('becomes stale when the text around an insertion point is deleted', () => {
    const { a, b } = pair('Premier paragraphe.\n\nUne phrase ici.\n\nDernier.')
    const at = a.toJSON().indexOf('ici')
    const { pending } = type(a, [{ from: at, insert: 'bien ' }])
    if (!pending) throw new Error('pending expected')
    expect(resolveSuggestion(a, pending)).toEqual({ status: 'open', from: at, to: at })
    // Le caractère précédent seul disparaît : l'insertion reste applicable.
    b.delete(at - 1, 1)
    expect(resolveSuggestion(a, pending)).toMatchObject({ status: 'open' })
    // Tout le paragraphe disparaît : obsolète, et l'acceptation n'insère rien.
    const start = b.toJSON().indexOf('Une')
    b.delete(start, b.toJSON().indexOf('\n\nDernier') - start)
    expect(a.toJSON()).toBe('Premier paragraphe.\n\n\n\nDernier.')
    expect(resolveSuggestion(a, pending)).toEqual({
      status: 'stale',
      reason: 'detached',
      at: start,
    })
    const accepted = { ...pending, id: 's1' }
    expect(applySuggestion(a, accepted, { decidedBy: BOB })).toBe('stale')
    expect(a.toJSON()).toBe('Premier paragraphe.\n\n\n\nDernier.')
  })

  it('keeps an insertion at the end of the text open when only its neighbour is deleted', () => {
    const { a, b } = pair('abc')
    const { pending } = type(a, [{ from: 3, insert: 'Z' }])
    if (!pending) throw new Error('pending expected')
    b.delete(2, 1)
    expect(resolveSuggestion(a, pending)).toMatchObject({ status: 'open', from: 2 })
  })

  it('becomes stale when the original text changes or disappears', () => {
    const { a, b } = pair('Le chien dort.')
    const { pending } = type(a, [{ from: 3, to: 8, insert: 'loup' }])
    expect(pending).toMatchObject({ kind: 'replace', originalText: 'chien' })
    if (!pending) throw new Error('pending expected')
    b.insert(5, 'u') // « chuien » : une frappe dans la plage
    expect(resolveSuggestion(a, pending)).toEqual({ status: 'stale', reason: 'changed', at: 3 })
    b.delete(3, 6)
    expect(a.toJSON()).toBe('Le  dort.')
    expect(resolveSuggestion(a, pending)).toEqual({ status: 'stale', reason: 'detached', at: 3 })
  })

  it('cannot resolve an anchor of another document or an unreadable one', () => {
    const text = textOf('abc')
    const elsewhere = createCommentAnchor(textOf('abc'), 0, 1)
    expect(
      resolveSuggestion(text, { kind: 'delete', anchor: elsewhere, originalText: 'a' }),
    ).toEqual({ status: 'unknown' })
    expect(
      resolveSuggestion(text, { kind: 'delete', anchor: 'pas@base64', originalText: 'a' }),
    ).toEqual({ status: 'unknown' })
    // Point utilisé pour une suppression : forme invalide.
    expect(
      resolveSuggestion(text, {
        kind: 'delete',
        anchor: createPointAnchor(text, 1),
        originalText: 'b',
      }),
    ).toEqual({ status: 'unknown' })
  })

  it('reads an anchor given in base64', () => {
    const text = textOf('abc')
    const anchor = anchorToBase64(createCommentAnchor(text, 1, 2))
    expect(resolveSuggestion(text, { kind: 'delete', anchor, originalText: 'b' })).toEqual({
      status: 'open',
      from: 1,
      to: 2,
    })
  })
})

describe('applying an accepted suggestion', () => {
  it('applies each kind once, with the given transaction origin', () => {
    const text = textOf('Le chien dort.')
    const origins: unknown[] = []
    text.doc?.on('afterTransaction', (transaction: Y.Transaction) => {
      origins.push(transaction.origin)
    })
    const replace = {
      id: 'r',
      kind: 'replace' as const,
      anchor: createCommentAnchor(text, 3, 8),
      originalText: 'chien',
      proposedText: 'chat',
    }
    const origin = { source: 'local', context: { userId: ADA } }
    expect(applySuggestion(text, replace, { decidedBy: BOB, origin })).toBe('applied')
    expect(text.toJSON()).toBe('Le chat dort.')
    expect(origins).toEqual([origin])
    expect(applySuggestion(text, replace, { decidedBy: BOB, origin })).toBe('already-applied')
    expect(text.toJSON()).toBe('Le chat dort.')
    expect(text.doc?.getMap(APPLIED_SUGGESTIONS_FIELD).get('r')).toBe(BOB)

    const insert = {
      id: 'i',
      kind: 'insert' as const,
      anchor: createPointAnchor(text, 7),
      originalText: '',
      proposedText: ' noir',
    }
    const remove = {
      id: 'd',
      kind: 'delete' as const,
      anchor: createCommentAnchor(text, 0, 3),
      originalText: 'Le ',
      proposedText: '',
    }
    expect(applySuggestion(text, insert, { decidedBy: BOB })).toBe('applied')
    expect(applySuggestion(text, remove, { decidedBy: BOB })).toBe('applied')
    expect(text.toJSON()).toBe('chat noir dort.')
  })

  it('does not apply a stale suggestion, nor one that overlaps an applied one', () => {
    const text = textOf('abcdef')
    const first = {
      id: '1',
      kind: 'replace' as const,
      anchor: createCommentAnchor(text, 1, 4),
      originalText: 'bcd',
      proposedText: 'X',
    }
    const overlapping = {
      id: '2',
      kind: 'delete' as const,
      anchor: createCommentAnchor(text, 3, 5),
      originalText: 'de',
      proposedText: '',
    }
    expect(applySuggestion(text, first, { decidedBy: BOB })).toBe('applied')
    expect(applySuggestion(text, overlapping, { decidedBy: BOB })).toBe('stale')
    expect(text.toJSON()).toBe('aXef')
    expect(text.doc?.getMap(APPLIED_SUGGESTIONS_FIELD).has('2')).toBe(false)
  })

  it('keeps the origin of an enclosing transaction', () => {
    const text = textOf('abc')
    const doc = text.doc
    if (!doc) throw new Error('doc expected')
    let seen: unknown = null
    doc.on('afterTransaction', (transaction: Y.Transaction) => {
      seen = transaction.origin
    })
    const outer = { source: 'local', context: { userId: ADA } }
    doc.transact(() => {
      applySuggestion(
        text,
        {
          id: 'x',
          kind: 'insert',
          anchor: createPointAnchor(text, 3),
          originalText: '',
          proposedText: 'd',
        },
        { decidedBy: BOB, origin: 'ignored' },
      )
    }, outer)
    expect(seen).toBe(outer)
    expect(text.toJSON()).toBe('abcd')
  })
})

describe('insertion points at the end of the text', () => {
  it('stays right after the last character when others append', () => {
    const { a, b } = pair('abc')
    const { pending } = type(a, [{ from: 3, insert: '!' }])
    if (!pending) throw new Error('pending expected')
    b.insert(3, ' et plus')
    expect(preview(a, pending)).toBe('abc! et plus')
  })
})
