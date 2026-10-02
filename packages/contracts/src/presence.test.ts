import { describe, expect, it } from 'vitest'
import {
  parsePresenceState,
  PRESENCE_FALLBACK_NAME,
  presenceColorIndex,
  presenceCssColor,
  presenceCssColorLight,
  presenceUserFor,
} from './presence.js'

const id = '0b9f8d3e-5a4c-4b1e-9f2a-3c4d5e6f7a8b'
const documentId = '6f1c2d3e-4b5a-4c7d-8e9f-0a1b2c3d4e5f'

describe('presence colors', () => {
  // Valeurs de `presenceColorIndex` et `presenceColor` de packages/ui (lib/avatars.ts) : les deux
  // implémentations doivent attribuer la même couleur au même collaborateur.
  it.each([
    [id, 5],
    [documentId, 1],
    ['00000000-0000-4000-8000-000000000001', 2],
    ['ada', 3],
  ])('derives the same color index as packages/ui for %s', (key, index) => {
    expect(presenceColorIndex(key)).toBe(index)
  })

  it('writes the same CSS values as packages/ui', () => {
    expect(presenceCssColor(5)).toBe('var(--presence-6)')
    expect(presenceCssColorLight(5)).toBe('color-mix(in oklab, var(--presence-6) 20%, transparent)')
  })
})

describe('presence state', () => {
  const user = presenceUserFor(id, '  Ada Lovelace ')

  it('builds a canonical identity', () => {
    expect(user).toEqual({
      id,
      name: 'Ada Lovelace',
      avatarUrl: null,
      colorIndex: 5,
      color: 'var(--presence-6)',
      colorLight: 'color-mix(in oklab, var(--presence-6) 20%, transparent)',
    })
    expect(presenceUserFor(id, '   ').name).toBe(PRESENCE_FALLBACK_NAME)
    expect(presenceUserFor(id, null).name).toBe(PRESENCE_FALLBACK_NAME)
    expect(presenceUserFor(id, 'x'.repeat(500)).name).toHaveLength(200)
  })

  it('keeps an https avatar only', () => {
    const avatar = 'https://img.clerk.com/ada.png'
    expect(presenceUserFor(id, 'Ada', avatar).avatarUrl).toBe(avatar)
    expect(parsePresenceState({ user: presenceUserFor(id, 'Ada', avatar) })).not.toBeNull()
    expect(presenceUserFor(id, 'Ada', 'http://img.example/ada.png').avatarUrl).toBeNull()
    expect(presenceUserFor(id, 'Ada', 'javascript:alert(1)').avatarUrl).toBeNull()
    expect(presenceUserFor(id, 'Ada', 'not a url').avatarUrl).toBeNull()
    expect(presenceUserFor(id, 'Ada', `https://x.test/${'a'.repeat(3000)}`).avatarUrl).toBeNull()
  })

  it('accepts meta and document states', () => {
    expect(parsePresenceState({ user, documentId })).toEqual({ user, documentId })
    const cursor = {
      anchor: { type: { client: 1, clock: 2 }, tname: null, item: null, assoc: 0 },
      head: { type: { client: 1, clock: 2 }, tname: null, item: null, assoc: 0 },
    }
    expect(parsePresenceState({ user, cursor })).toEqual({ user, cursor })
    expect(parsePresenceState({ user, cursor: null, documentId: null })).not.toBeNull()
  })

  it.each([
    ['no state', null],
    ['no user', { documentId }],
    ['a forged color index', { user: { ...user, colorIndex: (user.colorIndex + 1) % 8 } }],
    ['an injected color', { user: { ...user, color: 'red; background: url(x)' } }],
    ['an injected light color', { user: { ...user, colorLight: 'url(https://x)' } }],
    ['a malformed id', { user: { ...user, id: 'not-a-uuid' } }],
    ['an empty name', { user: { ...user, name: '' } }],
    ['an insecure avatar', { user: { ...user, avatarUrl: 'javascript:alert(1)' } }],
    ['no avatar field', { user: { ...user, avatarUrl: undefined } }],
    ['a malformed document', { user, documentId: '../x' }],
    ['a malformed cursor', { user, cursor: { anchor: 1, head: 2 } }],
  ])('rejects %s', (_label, state) => {
    expect(parsePresenceState(state)).toBeNull()
  })
})
