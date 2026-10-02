import { presenceUserFor } from '@kaxolax/contracts'
import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import {
  cursorIndexOf,
  groupPresence,
  nextFollowStep,
  peopleByDocument,
  presenceDescription,
} from './presence'

const SELF = '00000000-0000-4000-8000-000000000001'
const ALICE = '00000000-0000-4000-8000-00000000000a'
const BOB = '00000000-0000-4000-8000-00000000000b'
const DOC_1 = '10000000-0000-4000-8000-000000000001'
const DOC_2 = '10000000-0000-4000-8000-000000000002'

const state = (id: string, name: string, documentId: string | null = null, extra = {}) => ({
  user: presenceUserFor(id, name),
  documentId,
  ...extra,
})

describe('presence grouping', () => {
  it('groups tabs by person, excludes oneself, sorts by name and drops invalid states', () => {
    const states = new Map<number, unknown>([
      [5, state(BOB, 'Bob', DOC_1)],
      [1, state(SELF, 'Moi', DOC_1)],
      [3, state(ALICE, 'Alice', DOC_2)],
      [4, state(ALICE, 'Alice', DOC_1)],
      [6, state(ALICE, 'Alice', DOC_2)],
      // Couleur hors du thème, identité absente : ignorés.
      [7, { user: { ...presenceUserFor(BOB, 'Bob'), color: 'red' }, documentId: DOC_2 }],
      [8, { documentId: DOC_1 }],
      [9, null],
    ])
    const people = groupPresence(states, SELF)
    expect(people.map((person) => [person.user.name, person.documentIds])).toEqual([
      ['Alice', [DOC_2, DOC_1]],
      ['Bob', [DOC_1]],
    ])
    expect(
      peopleByDocument(people)
        .get(DOC_1)
        ?.map((user) => user.name),
    ).toEqual(['Alice', 'Bob'])
    expect(
      peopleByDocument(people)
        .get(DOC_2)
        ?.map((user) => user.name),
    ).toEqual(['Alice'])
  })

  it('describes where each person is', () => {
    const [alice] = groupPresence(new Map([[1, state(ALICE, 'Alice', DOC_1)]]), SELF)
    const nameOf = (id: string) => (id === DOC_1 ? 'main.tex' : null)
    expect(alice && presenceDescription(alice, nameOf)).toBe('Sur main.tex')
    const [idle] = groupPresence(new Map([[1, state(ALICE, 'Alice')]]), SELF)
    expect(idle && presenceDescription(idle, nameOf)).toBe('Aucun fichier ouvert')
  })
})

describe('following a collaborator', () => {
  const target = { userId: ALICE, name: 'Alice' }
  const exists = (id: string) => id === DOC_1 || id === DOC_2

  it('opens the file of the followed person, stays when already there, stops when offline', () => {
    const people = groupPresence(new Map([[1, state(ALICE, 'Alice', DOC_2)]]), SELF)
    expect(nextFollowStep(target, people, DOC_1, exists)).toEqual({
      kind: 'open',
      documentId: DOC_2,
    })
    expect(nextFollowStep(target, people, DOC_2, exists)).toEqual({ kind: 'stay' })
    expect(nextFollowStep(target, [], DOC_2, exists)).toEqual({ kind: 'stop', reason: 'offline' })
  })

  it('ignores files that are not (yet) in the local tree, and people with no file open', () => {
    const unknown = '10000000-0000-4000-8000-000000000099'
    const people = groupPresence(new Map([[1, state(ALICE, 'Alice', unknown)]]), SELF)
    expect(nextFollowStep(target, people, DOC_1, exists)).toEqual({ kind: 'stay' })
    const idle = groupPresence(new Map([[1, state(ALICE, 'Alice')]]), SELF)
    expect(nextFollowStep(target, idle, DOC_1, exists)).toEqual({ kind: 'stay' })
  })

  it('finds the cursor of the followed person in the text document', () => {
    const doc = new Y.Doc()
    const ytext = doc.getText('content')
    ytext.insert(0, 'hello world')
    const head = Y.relativePositionToJSON(
      Y.createRelativePositionFromTypeIndex(ytext, 6),
    ) as Record<string, unknown>
    const states = new Map<number, unknown>([
      [1, state(BOB, 'Bob', null, { cursor: { anchor: head, head } })],
      [2, state(ALICE, 'Alice', null, { cursor: null })],
      [3, state(ALICE, 'Alice', null, { cursor: { anchor: head, head } })],
    ])
    expect(cursorIndexOf(states, ALICE, ytext)).toBe(6)
    // Le texte change avant le curseur : la position relative suit.
    ytext.insert(0, '>> ')
    expect(cursorIndexOf(states, ALICE, ytext)).toBe(9)
    expect(cursorIndexOf(new Map([[2, state(ALICE, 'Alice')]]), ALICE, ytext)).toBeNull()
    // Position d'un autre document : ignorée.
    const other = new Y.Doc().getText('content')
    expect(cursorIndexOf(states, ALICE, other)).toBeNull()
    doc.destroy()
  })
})
