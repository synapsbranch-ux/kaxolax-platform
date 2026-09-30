import { describe, expect, it } from 'vitest'
import { cn } from './utils.js'

describe('cn', () => {
  it('joins classes and lets the last conflicting utility win', () => {
    expect(cn('px-2 py-1', false, 'px-4')).toBe('py-1 px-4')
  })
})
