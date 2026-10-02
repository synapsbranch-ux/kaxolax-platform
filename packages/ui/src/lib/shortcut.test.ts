import { describe, expect, it } from 'vitest'
import { formatShortcut, formatShortcutText } from './shortcut.js'

describe('formatShortcut', () => {
  it('uses symbols on Mac and names elsewhere', () => {
    expect(formatShortcut('Mod-Shift-k', true)).toEqual(['⇧', '⌘', 'K'])
    expect(formatShortcut('Mod-Shift-k', false)).toEqual(['Ctrl', 'Maj', 'K'])
    expect(formatShortcutText('Mod-Enter', false)).toBe('Ctrl+Entrée')
    expect(formatShortcutText('Mod-Enter', true)).toBe('⌘↩')
  })

  it('accepts a dash as the key', () => {
    expect(formatShortcut('Ctrl--', false)).toEqual(['Ctrl', '-'])
  })
})
