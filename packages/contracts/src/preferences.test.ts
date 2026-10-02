import { describe, expect, it } from 'vitest'
import {
  DEFAULT_PREFERENCES,
  jsonByteLength,
  MAX_OPEN_TABS_PER_PROJECT,
  MAX_OPEN_TABS_PROJECTS,
  MAX_PERSONAL_DICTIONARY_BYTES,
  MAX_PERSONAL_DICTIONARY_WORDS,
  MAX_PERSONAL_WORD_LENGTH,
  MAX_PREFERENCES_BYTES,
  MAX_RECENT_SYMBOLS,
  mergePreferences,
  resolvePreferences,
  sanitizePreferences,
  type UserPreferences,
  userPreferencesSchema,
} from './preferences.js'

const projectA = '6f1c2d3e-4b5a-4c7d-8e9f-0a1b2c3d4e5f'
const projectB = '0b8f7e6d-5c4b-4a39-8281-7f6e5d4c3b2a'
const docA = '11111111-1111-4111-8111-111111111111'
const docB = '22222222-2222-4222-8222-222222222222'

/** Id de projet n° index, au format uuid v4. */
const projectId = (index: number) =>
  `aaaaaaaa-aaaa-4aaa-8aaa-${index.toString(16).padStart(12, '0')}`

describe('userPreferencesSchema', () => {
  it('accepts an empty object and every documented key', () => {
    expect(userPreferencesSchema.parse({})).toEqual({})
    expect(() => userPreferencesSchema.parse(DEFAULT_PREFERENCES)).not.toThrow()
  })

  it.each([
    { theme: 'blue' },
    { layout: { sidebarSize: 120 } },
    { unknownKey: true },
    { layout: { unknown: 1 } },
    { editor: { keymap: 'nano' } },
    { editor: { fontSize: 100 } },
    { openTabs: { 'not-a-uuid': { documentIds: [], activeDocumentId: null } } },
    { openTabs: { [projectA]: { documentIds: ['x'], activeDocumentId: null } } },
    { recentSymbols: ['alpha'] },
    { recentSymbols: ['\\a b'] },
    { recentSymbols: 'not-an-array' },
    { spellcheckDictionary: ['deux mots'] },
    { spellcheckDictionary: ['\\cmd'] },
    { spellcheckDictionary: ["'apostrophe"] },
    { spellcheckDictionary: ['mot', 'mot'] },
    { spellcheckDictionary: ['x'.repeat(MAX_PERSONAL_WORD_LENGTH + 1)] },
  ])('rejects %j', (value) => {
    expect(userPreferencesSchema.safeParse(value).success).toBe(false)
  })

  it('bounds the number of remembered projects', () => {
    const openTabs = Object.fromEntries(
      Array.from({ length: MAX_OPEN_TABS_PROJECTS + 1 }, (_, index) => [
        projectId(index),
        { documentIds: [], activeDocumentId: null },
      ]),
    )
    expect(userPreferencesSchema.safeParse({ openTabs }).success).toBe(false)
  })

  it('bounds the recent symbols', () => {
    const recentSymbols = Array.from({ length: MAX_RECENT_SYMBOLS }, () => '\\alpha')
    expect(userPreferencesSchema.safeParse({ recentSymbols }).success).toBe(true)
    expect(
      userPreferencesSchema.safeParse({ recentSymbols: [...recentSymbols, '\\beta'] }).success,
    ).toBe(false)
  })

  it('bounds the personal dictionary in words and in bytes', () => {
    const suffix = (index: number) =>
      [0, 1, 2]
        .map((rank) => String.fromCharCode(97 + (Math.floor(index / 26 ** rank) % 26)))
        .join('')
    const short = Array.from({ length: MAX_PERSONAL_DICTIONARY_WORDS }, (_, i) => `m${suffix(i)}`)
    expect(userPreferencesSchema.safeParse({ spellcheckDictionary: short }).success).toBe(true)
    expect(
      userPreferencesSchema.safeParse({ spellcheckDictionary: [...short, 'encore'] }).success,
    ).toBe(false)

    // Mots les plus longs, à 3 octets par lettre : la borne en octets s'applique avant.
    const long = (index: number) => `${'ア'.repeat(MAX_PERSONAL_WORD_LENGTH - 3)}${suffix(index)}`
    const words = worstDictionary(long)
    expect(words.length).toBeLessThan(MAX_PERSONAL_DICTIONARY_WORDS)
    expect(userPreferencesSchema.safeParse({ spellcheckDictionary: words }).success).toBe(true)
    expect(
      userPreferencesSchema.safeParse({
        spellcheckDictionary: [...words, long(words.length)],
      }).success,
    ).toBe(false)
    expect(
      userPreferencesSchema.safeParse({
        spellcheckDictionary: ["aujourd'hui", 'porte-monnaie', 'Kaxolax', 'l’arbre'],
      }).success,
    ).toBe(true)
  })

  it('keeps the worst case of every key together under the stored size limit', () => {
    const uuid = (n: number) => `${n.toString(16).padStart(8, '0')}-1111-4111-8111-111111111111`
    const openTabs = Object.fromEntries(
      Array.from({ length: MAX_OPEN_TABS_PROJECTS }, (_, p) => [
        uuid(p),
        {
          documentIds: Array.from({ length: MAX_OPEN_TABS_PER_PROJECT }, (_, d) => uuid(1000 + d)),
          activeDocumentId: uuid(999),
          usedSeq: Number.MAX_SAFE_INTEGER,
        },
      ]),
    )
    // Caractères de contrôle : 6 octets chacun une fois échappés en JSON.
    const control = '\u0001'
    const preferences: UserPreferences = {
      theme: 'light',
      layout: {
        sidebarSize: 33.333333333333336,
        editorSize: 33.333333333333336,
        pdfSize: 33.333333333333336,
        sidebarCollapsed: false,
      },
      toolsVisible: true,
      autoCompile: true,
      compile: { draft: true, haltOnFirstError: true },
      openTabs,
      editor: {
        fontFamily: control.repeat(100),
        fontSize: 32,
        lineHeight: 2.9999999999999996,
        keymap: 'default',
        wrap: false,
        spellcheck: false,
        syntaxTheme: 'a'.repeat(50),
      },
      recentSymbols: Array.from(
        { length: MAX_RECENT_SYMBOLS },
        (_, i) => `\\${String(i).padStart(2, '0')}${control.repeat(61)}`,
      ),
      spellcheckDictionary: worstDictionary(
        (i) =>
          `${'ア'.repeat(MAX_PERSONAL_WORD_LENGTH - 4)}${String.fromCharCode(0x3041 + (i % 80))}${String.fromCharCode(0x30a1 + Math.floor(i / 80))}`,
      ),
    }
    expect(userPreferencesSchema.safeParse(preferences).success).toBe(true)
    expect(jsonByteLength(preferences)).toBeLessThan(MAX_PREFERENCES_BYTES)
  })
})

/** Dictionnaire le plus lourd accepté : mots ajoutés tant que la borne en octets le permet. */
function worstDictionary(word: (index: number) => string): string[] {
  const words: string[] = []
  while (jsonByteLength([...words, word(words.length)]) <= MAX_PERSONAL_DICTIONARY_BYTES) {
    words.push(word(words.length))
  }
  return words
}

describe('mergePreferences', () => {
  it('merges nested objects and keeps untouched keys', () => {
    const current = { theme: 'light' as const, layout: { sidebarSize: 20, pdfSize: 40 } }
    expect(mergePreferences(current, { layout: { pdfSize: 50 }, toolsVisible: true })).toEqual({
      theme: 'light',
      layout: { sidebarSize: 20, pdfSize: 50 },
      toolsVisible: true,
    })
  })

  it('replaces arrays instead of concatenating them', () => {
    const current = {
      openTabs: { [projectA]: { documentIds: [docA, docB], activeDocumentId: docB } },
    }
    const merged = mergePreferences(current, {
      openTabs: { [projectA]: { documentIds: [docB], activeDocumentId: docB } },
    })
    expect(merged.openTabs).toEqual({
      [projectA]: { documentIds: [docB], activeDocumentId: docB, usedSeq: 1 },
    })
  })

  it('keeps the tabs of other projects', () => {
    const merged = mergePreferences(
      { openTabs: { [projectA]: { documentIds: [docA], activeDocumentId: docA } } },
      { openTabs: { [projectB]: { documentIds: [], activeDocumentId: null } } },
    )
    expect(Object.keys(merged.openTabs ?? {})).toEqual([projectA, projectB])
  })

  it('numbers each change and ignores the number sent by the client', () => {
    let prefs = mergePreferences(
      {},
      { openTabs: { [projectA]: { documentIds: [], activeDocumentId: null, usedSeq: 99 } } },
    )
    expect(prefs.openTabs?.[projectA]?.usedSeq).toBe(1)
    prefs = mergePreferences(prefs, {
      openTabs: { [projectB]: { documentIds: [], activeDocumentId: null } },
    })
    prefs = mergePreferences(prefs, { theme: 'light' })
    expect(prefs.openTabs?.[projectB]?.usedSeq).toBe(2)
    expect(prefs.openTabs?.[projectA]?.usedSeq).toBe(1)
  })

  it('drops the least recently changed projects beyond the limit, whatever the key order', () => {
    let prefs: UserPreferences = {}
    for (let index = 0; index <= MAX_OPEN_TABS_PROJECTS; index++) {
      prefs = mergePreferences(prefs, {
        openTabs: { [projectId(index)]: { documentIds: [], activeDocumentId: null } },
      })
    }
    // Le projet 1 est modifié à nouveau : il devient le plus récent et le projet 2 sort ensuite.
    prefs = mergePreferences(prefs, {
      openTabs: { [projectId(1)]: { documentIds: [docA], activeDocumentId: docA } },
    })
    // jsonb réordonne les clés : l'ordre de l'objet stocké ne compte pas.
    const reversed = Object.fromEntries(Object.entries(prefs.openTabs ?? {}).toReversed())
    prefs = mergePreferences(
      { openTabs: reversed },
      { openTabs: { [projectId(30)]: { documentIds: [], activeDocumentId: null } } },
    )
    const keys = Object.keys(prefs.openTabs ?? {})
    expect(keys).toHaveLength(MAX_OPEN_TABS_PROJECTS)
    expect(keys).not.toContain(projectId(0))
    expect(keys).not.toContain(projectId(2))
    expect(keys).toContain(projectId(1))
    expect(keys).toContain(projectId(30))
  })
})

describe('sanitizePreferences', () => {
  it('drops only the invalid keys of stored preferences', () => {
    const stored = {
      theme: 'light',
      toolsVisible: true,
      removedKey: 1,
      layout: { sidebarSize: 30, pdfSize: 400 },
      editor: { syntaxTheme: 'Not Valid', fontSize: 16 },
      openTabs: {
        [projectA]: { documentIds: [docA], activeDocumentId: docA, usedSeq: 3 },
        [projectB]: { documentIds: ['x'], activeDocumentId: null },
        'not-a-uuid': { documentIds: [], activeDocumentId: null },
      },
    }
    expect(sanitizePreferences(stored)).toEqual({
      theme: 'light',
      toolsVisible: true,
      layout: { sidebarSize: 30 },
      editor: { fontSize: 16 },
      openTabs: { [projectA]: { documentIds: [docA], activeDocumentId: docA, usedSeq: 3 } },
    })
  })

  it('returns valid preferences unchanged and never throws', () => {
    const valid = { theme: 'dark' as const, autoCompile: true }
    expect(sanitizePreferences(valid)).toEqual(valid)
    expect(sanitizePreferences(null)).toEqual({})
    expect(sanitizePreferences([1, 2])).toEqual({})
    expect(sanitizePreferences({ layout: 'wide' })).toEqual({})
  })
})

describe('resolvePreferences', () => {
  it('applies the defaults', () => {
    expect(resolvePreferences({})).toEqual(DEFAULT_PREFERENCES)
    expect(DEFAULT_PREFERENCES).toMatchObject({
      theme: 'dark',
      toolsVisible: false,
      autoCompile: false,
      compile: { draft: false, haltOnFirstError: false },
    })
  })

  it('keeps stored values over the defaults, key by key', () => {
    const resolved = resolvePreferences({
      layout: { sidebarCollapsed: true },
      editor: { keymap: 'vim' },
    })
    expect(resolved.layout).toEqual({ ...DEFAULT_PREFERENCES.layout, sidebarCollapsed: true })
    expect(resolved.editor.keymap).toBe('vim')
    expect(resolved.editor.fontSize).toBe(DEFAULT_PREFERENCES.editor.fontSize)
    expect(resolved.recentSymbols).toEqual([])
    expect(resolvePreferences({ recentSymbols: ['\\alpha'] }).recentSymbols).toEqual(['\\alpha'])
  })
})
