import type { ZoteroLink } from '@kaxolax/contracts'
import { describe, expect, it, vi } from 'vitest'
import { ApiError } from './api'
import { eventEffect } from './project-events'
import {
  citationsOf,
  collectionTree,
  relativeTime,
  zoteroErrorMessage,
  zoteroFeed,
  zoteroLinkStatus,
  zoteroSourceLabel,
} from './zotero'

const ID = '00000000-0000-4000-8000-000000000001'
const NOW = Date.parse('2026-10-03T12:00:00.000Z')

function link(overrides: Partial<ZoteroLink> = {}): ZoteroLink {
  return {
    id: ID,
    projectId: ID,
    ownerId: ID,
    ownerName: 'Ada Lovelace',
    libraryType: 'user',
    libraryId: '1234567',
    libraryName: 'Bibliothèque de ada',
    collectionKey: 'THES2345',
    collectionName: 'Thèse',
    documentId: ID,
    documentPath: 'references.bib',
    exportFormat: 'biblatex',
    syncStatus: 'idle',
    lastSyncedAt: '2026-10-03T11:55:00.000Z',
    lastLibraryVersion: 10,
    lastError: null,
    backoffUntil: null,
    hasKey: true,
    createdAt: '2026-10-03T10:00:00.000Z',
    ...overrides,
  }
}

describe('zotero link status', () => {
  it('shows the last synchronization', () => {
    expect(zoteroLinkStatus(link(), NOW)).toEqual({
      tone: 'ok',
      label: 'Synchronisé il y a 5 min',
      error: null,
    })
    expect(zoteroLinkStatus(link({ lastSyncedAt: null }), NOW).label).toBe('Jamais synchronisé')
    expect(zoteroLinkStatus(link({ syncStatus: 'syncing' }), NOW).tone).toBe('busy')
  })

  it('explains errors, revoked keys and pauses asked by Zotero', () => {
    const failed = zoteroLinkStatus(
      link({ syncStatus: 'error', lastError: 'E_ZOTERO_LIBRARY_NOT_FOUND' }),
      NOW,
    )
    expect(failed.tone).toBe('error')
    expect(failed.error).toBe('Bibliothèque ou collection Zotero introuvable.')
    expect(zoteroLinkStatus(link({ hasKey: false }), NOW).error).toMatch(/révoquée/)
    const paused = zoteroLinkStatus(link({ backoffUntil: '2026-10-03T12:00:30.000Z' }), NOW)
    expect(paused.tone).toBe('waiting')
    expect(paused.label).toContain('30 s')
    expect(
      zoteroLinkStatus(
        link({
          syncStatus: 'error',
          lastError: 'E_ZOTERO_BACKOFF',
          backoffUntil: '2026-10-03T12:02:00.000Z',
        }),
        NOW,
      ).tone,
    ).toBe('waiting')
  })

  it('formats relative times', () => {
    expect(relativeTime('2026-10-03T11:59:30.000Z', NOW)).toBe('à l’instant')
    expect(relativeTime('2026-10-03T09:00:00.000Z', NOW)).toBe('il y a 3 h')
    expect(relativeTime('2026-10-01T12:00:00.000Z', NOW)).toBe('il y a 2 j')
  })

  it('names the synchronized source', () => {
    expect(zoteroSourceLabel(link())).toBe('Thèse — Bibliothèque de ada')
    expect(zoteroSourceLabel(link({ collectionKey: null }))).toBe(
      'Bibliothèque de ada (toute la bibliothèque)',
    )
  })
})

describe('zotero helpers', () => {
  it('turns search results with a key into citations', () => {
    expect(
      citationsOf([
        {
          itemKey: 'AAAA2222',
          citationKey: 'lovelace_1843',
          itemType: 'journalArticle',
          title: 'Notes',
          creators: 'Lovelace',
          year: '1843',
          inBibliography: false,
        },
        {
          itemKey: 'BBBB3333',
          citationKey: null,
          itemType: 'note',
          title: '',
          creators: '',
          year: null,
          inBibliography: false,
        },
      ]),
    ).toEqual([{ key: 'lovelace_1843', id: 'AAAA2222', title: 'Notes', detail: 'Lovelace 1843' }])
  })

  it('orders collections as a tree', () => {
    const tree = collectionTree([
      { key: 'CCCC2222', name: 'Chapitre 2', parentKey: 'AAAA2222' },
      { key: 'AAAA2222', name: 'Thèse', parentKey: null },
      { key: 'BBBB2222', name: 'Articles', parentKey: null },
      { key: 'DDDD2222', name: 'Orpheline', parentKey: 'ZZZZ9999' },
    ])
    expect(tree.map(({ collection, depth }) => `${String(depth)}:${collection.name}`)).toEqual([
      '0:Articles',
      '0:Orpheline',
      '0:Thèse',
      '1:Chapitre 2',
    ])
  })

  it('translates API errors', () => {
    expect(zoteroErrorMessage(new ApiError(503, 'E_ZOTERO_UNAVAILABLE', 'x'))).toBe(
      'L’intégration Zotero n’est pas configurée sur ce service.',
    )
    expect(zoteroErrorMessage(new ApiError(403, 'E_PROJECT_FORBIDDEN', 'x'))).toMatch(/droits/)
  })

  it('forwards zotero.updated events to the feed', () => {
    const event = { type: 'zotero.updated' as const, actorId: ID, link: null }
    const effect = eventEffect(event, ID)
    expect(effect).toEqual({ kind: 'zotero', event })
    const listener = vi.fn()
    const unsubscribe = zoteroFeed.subscribe(listener)
    zoteroFeed.publish(event)
    unsubscribe()
    zoteroFeed.publish(event)
    expect(listener).toHaveBeenCalledTimes(1)
  })
})
