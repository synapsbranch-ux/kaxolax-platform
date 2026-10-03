import * as Y from 'yjs'
import { describe, expect, it } from 'vitest'
import {
  containsState,
  decodeDocumentState,
  encodeDocumentState,
  waitForStates,
} from '../src/catch-up.js'

/** Deux copies d'un même document, comme sur deux instances. */
function replicas(text: string) {
  const source = new Y.Doc()
  source.getText('content').insert(0, text)
  const copy = new Y.Doc()
  Y.applyUpdate(copy, Y.encodeStateAsUpdate(source))
  const state = () => {
    const decoded = decodeDocumentState(encodeDocumentState(source))
    if (!decoded) throw new Error('state not decoded')
    return decoded
  }
  const sync = () => {
    Y.applyUpdate(copy, Y.encodeStateAsUpdate(source, Y.encodeStateVector(copy)))
  }
  return { source, copy, state, sync }
}

describe('catching up with another instance', () => {
  it('waits for insertions', () => {
    const { source, copy, state, sync } = replicas('Bonjour')
    expect(containsState(copy, state())).toBe(true)
    source.getText('content').insert(7, ' le monde')
    expect(containsState(copy, state())).toBe(false)
    sync()
    expect(containsState(copy, state())).toBe(true)
  })

  it('waits for a deletion, which does not move the state vector', () => {
    const { source, copy, state, sync } = replicas('Bonjour le monde')
    source.getText('content').delete(7, 9)
    expect(Y.encodeStateVector(source)).toEqual(Y.encodeStateVector(copy))
    expect(containsState(copy, state())).toBe(false)
    sync()
    expect(copy.getText('content').toJSON()).toBe('Bonjour')
    expect(containsState(copy, state())).toBe(true)
    // Une copie plus avancée que l'autre instance la contient aussi.
    copy.getText('content').delete(0, 3)
    copy.getText('content').insert(0, 'B')
    expect(containsState(copy, state())).toBe(true)
  })

  it('needs each deleted range inside a range deleted here', () => {
    const { source, copy, state, sync } = replicas('abcdefghij')
    source.getText('content').delete(2, 2)
    sync()
    source.getText('content').delete(5, 2)
    // La première suppression est connue ici, pas la seconde.
    expect(containsState(copy, state())).toBe(false)
    sync()
    expect(containsState(copy, state())).toBe(true)
  })

  it('stops waiting at the deadline, and ignores an unreadable state', async () => {
    const { source, copy, state } = replicas('Bonjour')
    source.getText('content').insert(0, '!')
    expect(await waitForStates(copy, [state()], Date.now() + 50, 10)).toBe(false)
    expect(await waitForStates(copy, [], Date.now())).toBe(true)
    expect(decodeDocumentState('###')).toBeNull()
  })
})
