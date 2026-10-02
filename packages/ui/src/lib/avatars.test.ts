import { describe, expect, it } from 'vitest'
import { initialsOf, presenceColor, presenceColorIndex, splitAvatarStack } from './avatars.js'

describe('splitAvatarStack', () => {
  const people = ['a', 'b', 'c', 'd', 'e', 'f']

  it('shows everyone when the stack fits', () => {
    expect(splitAvatarStack(people.slice(0, 4), 4)).toEqual({
      visible: ['a', 'b', 'c', 'd'],
      overflow: [],
    })
  })

  it('keeps the last slot for a +N badge, never +1', () => {
    const { visible, overflow } = splitAvatarStack(people, 4)
    expect(visible).toEqual(['a', 'b', 'c'])
    expect(overflow).toEqual(['d', 'e', 'f'])
    expect(splitAvatarStack(people.slice(0, 5), 4).overflow).toHaveLength(2)
  })

  it('treats invalid limits as one slot', () => {
    expect(splitAvatarStack(people, 0)).toEqual({ visible: [], overflow: people })
    expect(splitAvatarStack(people, Number.NaN).overflow).toHaveLength(6)
  })
})

describe('presence colors', () => {
  it('gives a stable index between 0 and 7', () => {
    const index = presenceColorIndex('user-42')
    expect(index).toBe(presenceColorIndex('user-42'))
    expect(index).toBeGreaterThanOrEqual(0)
    expect(index).toBeLessThan(8)
  })

  it('maps any index to a theme variable', () => {
    expect(presenceColor(0)).toBe('var(--presence-1)')
    expect(presenceColor(9)).toBe('var(--presence-2)')
    expect(presenceColor(-1)).toBe('var(--presence-8)')
    expect(presenceColor(2, 0.25)).toBe('color-mix(in oklab, var(--presence-3) 25%, transparent)')
  })
})

describe('initialsOf', () => {
  it('builds initials from names and emails', () => {
    expect(initialsOf('Ada Lovelace')).toBe('AL')
    expect(initialsOf('Jean-Pierre Dupont')).toBe('JD')
    expect(initialsOf('ada.lovelace@exemple.fr')).toBe('AL')
    expect(initialsOf('élodie')).toBe('É')
    expect(initialsOf('  ')).toBe('?')
  })
})
