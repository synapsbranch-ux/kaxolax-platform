import { describe, expect, it } from 'vitest'
import { zoteroUpdatedEventSchema } from './events.js'
import {
  linkZoteroInputSchema,
  zoteroCallbackQuerySchema,
  zoteroKeySchema,
  zoteroSearchQuerySchema,
  zoteroSyncInputSchema,
} from './zotero.js'

const id = '0b8f7e6d-5c4b-4a39-8281-7f6e5d4c3b2a'

describe('zotero contracts', () => {
  it('accepts Zotero keys only', () => {
    expect(zoteroKeySchema.safeParse('ABCD2345').success).toBe(true)
    // Ni O, ni 0, ni 1, ni minuscule.
    expect(zoteroKeySchema.safeParse('ABCO2345').success).toBe(false)
    expect(zoteroKeySchema.safeParse('ABCD0145').success).toBe(false)
    expect(zoteroKeySchema.safeParse('abcd2345').success).toBe(false)
  })

  it('validates a link request with a new .bib or an existing document', () => {
    const base = { libraryType: 'user', libraryId: '1234567', collectionKey: null }
    expect(
      linkZoteroInputSchema.parse({
        ...base,
        target: { kind: 'new', name: 'references.bib', folderId: null },
      }).exportFormat,
    ).toBe('biblatex')
    expect(
      linkZoteroInputSchema.safeParse({
        ...base,
        target: { kind: 'new', name: 'references.tex', folderId: null },
      }).success,
    ).toBe(false)
    expect(
      linkZoteroInputSchema.safeParse({
        ...base,
        libraryId: '0',
        target: { kind: 'existing', documentId: id },
      }).success,
    ).toBe(false)
    expect(
      linkZoteroInputSchema.safeParse({
        ...base,
        exportFormat: 'csljson',
        target: { kind: 'existing', documentId: id },
      }).success,
    ).toBe(false)
  })

  it('bounds the search query and the callback parameters', () => {
    expect(zoteroSearchQuerySchema.parse({ q: '  ada ' }).q).toBe('ada')
    expect(zoteroSearchQuerySchema.safeParse({ q: 'a' }).success).toBe(false)
    expect(zoteroSyncInputSchema.parse({}).trigger).toBe('manual')
    expect(
      zoteroCallbackQuerySchema.safeParse({ oauth_token: 't', oauth_verifier: 'v' }).success,
    ).toBe(false)
  })

  it('announces a removed link', () => {
    expect(
      zoteroUpdatedEventSchema.parse({ type: 'zotero.updated', actorId: id, link: null }),
    ).toEqual({ type: 'zotero.updated', actorId: id, link: null })
  })
})
