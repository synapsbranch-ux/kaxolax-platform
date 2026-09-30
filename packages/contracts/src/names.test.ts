import { describe, expect, it } from 'vitest'
import { isSafeRelativePath, isValidEntityName, MAX_NAME_BYTES } from './names.js'

describe('isValidEntityName', () => {
  it.each(['main.tex', 'figure 1.png', 'références.bib', '.latexmkrc', 'a.b.c', 'é'.repeat(127)])(
    'accepts %s',
    (name) => {
      expect(isValidEntityName(name)).toBe(true)
    },
  )

  it.each([
    ['empty', ''],
    ['blank', '   '],
    ['dot', '.'],
    ['double dot', '..'],
    ['containing ..', 'a..b.tex'],
    ['slash', 'a/b'],
    ['backslash', 'a\\b'],
    ['NUL', 'a\u0000b'],
    ['newline', 'a\nb'],
    ['DEL', 'a\u007fb'],
    ['too long', 'a'.repeat(MAX_NAME_BYTES + 1)],
    ['too many UTF-8 bytes', 'é'.repeat(128)],
  ])('rejects %s', (_label, name) => {
    expect(isValidEntityName(name)).toBe(false)
  })

  it('accepts exactly 255 bytes', () => {
    expect(isValidEntityName('a'.repeat(MAX_NAME_BYTES))).toBe(true)
  })
})

describe('isSafeRelativePath', () => {
  it.each(['main.tex', 'chapters/intro.tex', 'a/b/c/d.png'])('accepts %s', (path) => {
    expect(isSafeRelativePath(path)).toBe(true)
  })

  it.each([
    '',
    '/etc/passwd',
    '../secret.tex',
    'chapters/../../x',
    'chapters/./intro.tex',
    'chapters//intro.tex',
    'chapters/',
    'C:\\Windows\\win.ini',
    'a/b\u0000.tex',
    `${'a/'.repeat(600)}x`,
  ])('rejects %j', (path) => {
    expect(isSafeRelativePath(path)).toBe(false)
  })
})
