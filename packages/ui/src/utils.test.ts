import { describe, expect, it } from 'vitest'
import { cn } from './utils.js'

describe('cn', () => {
  it('joins classes and lets the last conflicting utility win', () => {
    expect(cn('px-2 py-1', false, 'px-4')).toBe('py-1 px-4')
  })

  it('knows the named spacings of the design tokens', () => {
    expect(cn('h-9 px-2', 'h-bar px-gutter')).toBe('h-bar px-gutter')
    expect(cn('w-rail', 'w-64')).toBe('w-64')
  })

  it('keeps token colors and font sizes apart', () => {
    expect(cn('text-sm text-sidebar-foreground')).toBe('text-sm text-sidebar-foreground')
    expect(cn('bg-primary', 'bg-tools')).toBe('bg-tools')
  })
})
