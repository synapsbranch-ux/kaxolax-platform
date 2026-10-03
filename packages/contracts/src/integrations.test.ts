import { describe, expect, it } from 'vitest'
import { gitLinkSchema, zoteroLinkSchema } from './integrations.js'

const id = '0b8f7e6d-5c4b-4a39-8281-7f6e5d4c3b2a'

describe('integration contracts', () => {
  it('describes a git link without its tokens', () => {
    const link = {
      id,
      projectId: id,
      ownerId: id,
      provider: 'github',
      repositoryOwner: 'kaxolax',
      repositoryName: 'thesis',
      branch: 'main',
      syncStatus: 'idle',
      lastSyncedAt: null,
      lastSyncedCommit: null,
      lastError: null,
      createdAt: '2026-10-03T10:00:00.000Z',
    }
    expect(gitLinkSchema.parse({ ...link, accessToken: 'ghu_x' })).toEqual(link)
    expect(gitLinkSchema.safeParse({ ...link, provider: 'gitlab' }).success).toBe(false)
  })

  it('describes a Zotero link to a collection', () => {
    const link = {
      id,
      projectId: id,
      ownerId: id,
      ownerName: 'Ada Lovelace',
      libraryType: 'group',
      libraryId: '12345',
      libraryName: 'Lab',
      collectionKey: 'ABCD2345',
      collectionName: 'Thesis',
      documentId: null,
      documentPath: null,
      exportFormat: 'biblatex',
      syncStatus: 'error',
      lastSyncedAt: '2026-10-03T10:00:00.000Z',
      lastLibraryVersion: 42,
      lastError: 'Invalid API key',
      backoffUntil: null,
      hasKey: true,
      createdAt: '2026-10-03T09:00:00.000Z',
    }
    expect(zoteroLinkSchema.parse(link)).toEqual(link)
    expect(zoteroLinkSchema.safeParse({ ...link, libraryType: 'team' }).success).toBe(false)
  })
})
