import { describe, expect, it } from 'vitest'
import { createLatestState } from './latest-state'

describe('latest state', () => {
  it('applies a read when nothing newer arrived', () => {
    const state = createLatestState()
    const current = state.begin()
    expect(current()).toBe(true)
  })

  it('drops a read started before a live event', () => {
    const state = createLatestState()
    const current = state.begin()
    state.live()
    expect(current()).toBe(false)
    // Une lecture partie après l'événement est à jour.
    expect(state.begin()()).toBe(true)
  })

  it('drops a read overtaken by a more recent one', () => {
    const state = createLatestState()
    const older = state.begin()
    const newer = state.begin()
    expect(older()).toBe(false)
    expect(newer()).toBe(true)
  })
})
