import type { ProjectVersion } from '@kaxolax/contracts'
import { describe, expect, it } from 'vitest'
import { ApiError } from './api'
import {
  authorColors,
  changedEntries,
  dayLabel,
  diffLines,
  diffStats,
  groupByDay,
  historyErrorMessage,
  restoreRemovals,
} from './history'

const ADA = '00000000-0000-4000-8000-000000000001'
const BOB = '00000000-0000-4000-8000-000000000002'

function version(id: string, createdAt: string): ProjectVersion {
  return { id, kind: 'auto', label: null, authorIds: [], changedDocumentIds: [], createdAt }
}

describe('history helpers', () => {
  it('groups versions by local day, keeping the order', () => {
    const at = (day: number, hour: number) => new Date(2026, 9, day, hour).toISOString()
    const groups = groupByDay([
      version('a', at(2, 18)),
      version('b', at(2, 9)),
      version('c', at(1, 23)),
    ])
    expect(groups.map((group) => group.versions.map((entry) => entry.id))).toEqual([
      ['a', 'b'],
      ['c'],
    ])
    const now = new Date(2026, 9, 2, 12)
    expect(dayLabel(groups[0]?.day ?? '', now)).toBe("Aujourd'hui")
    expect(dayLabel(groups[1]?.day ?? '', now)).toBe('Hier')
    expect(dayLabel('2026-09-15', now)).toContain('septembre')
  })

  it('gives each author the color of their presence, grey when unknown', () => {
    expect(authorColors(ADA)).toEqual(authorColors(ADA))
    expect(authorColors(ADA).color).toMatch(/^var\(--presence-[1-8]\)$/)
    expect(authorColors(null).color).toBe('var(--muted-foreground)')
  })

  it('counts changes per author and keeps changed entries', () => {
    expect(
      diffStats([
        { op: 'equal', text: 'abc', authorId: null },
        { op: 'insert', text: 'xy', authorId: ADA },
        { op: 'delete', text: 'z', authorId: BOB },
        { op: 'insert', text: 'w', authorId: ADA },
      ]),
    ).toEqual([
      { authorId: ADA, inserted: 3, deleted: 0 },
      { authorId: BOB, inserted: 0, deleted: 1 },
    ])
    const entry = {
      type: 'document' as const,
      id: ADA,
      path: 'a.tex',
      sha256: 'a'.repeat(64),
      previousPath: null,
    }
    expect(
      changedEntries([
        { ...entry, status: 'unchanged' },
        { ...entry, status: 'unchanged', previousPath: 'b.tex' },
        { ...entry, status: 'modified' },
      ]).map((item) => item.previousPath ?? item.status),
    ).toEqual(['b.tex', 'modified'])
  })

  it('splits a diff into numbered lines and folds long unchanged passages', () => {
    const text = Array.from({ length: 20 }, (_, index) => `ligne ${String(index + 1)}`).join('\n')
    const lines = diffLines(
      [
        { op: 'equal', text: `${text}\n`, authorId: null },
        { op: 'insert', text: 'nouvelle', authorId: ADA },
      ],
      2,
    )
    expect(lines[0]).toBeNull()
    expect(lines.slice(1).map((line) => line?.number)).toEqual([19, 20, 21])
    expect(lines.at(-1)?.parts).toEqual([{ op: 'insert', text: 'nouvelle', authorId: ADA }])
  })
})

describe('restore warnings', () => {
  const tree = {
    documents: [
      { id: 'main', folderId: null, name: 'main.tex', path: 'main.tex' },
      { id: 'new', folderId: null, name: 'new.tex', path: 'new.tex' },
    ],
    files: [
      {
        id: 'img2',
        folderId: null,
        name: 'plot.png',
        path: 'plot.png',
        sizeBytes: 1,
        mimeType: 'image/png',
      },
    ],
  }
  const threads = [{ documentId: 'new' }, { documentId: 'new' }, { documentId: 'main' }]

  it('lists what a whole restore removes and the comment threads lost with it', () => {
    const entries = [
      { id: 'main', status: 'unchanged' as const },
      { id: 'img', status: 'unchanged' as const },
      { id: 'gone', status: 'deleted' as const },
    ]
    expect(restoreRemovals({ scope: 'project' }, entries, tree, threads)).toEqual({
      paths: ['new.tex', 'plot.png'],
      threads: 2,
    })
  })

  it('names the item a single restored file replaces', () => {
    expect(restoreRemovals({ entry: { id: 'img', path: 'plot.png' } }, [], tree, threads)).toEqual({
      paths: ['plot.png'],
      threads: 0,
    })
    expect(restoreRemovals({ entry: { id: 'old', path: 'new.tex' } }, [], tree, threads)).toEqual({
      paths: ['new.tex'],
      threads: 2,
    })
    expect(restoreRemovals({ entry: { id: 'main', path: 'main.tex' } }, [], tree, threads)).toEqual(
      { paths: [], threads: 0 },
    )
  })

  it('shows restore errors in French', () => {
    expect(
      historyErrorMessage(new ApiError(503, 'E_HISTORY_REALTIME_UNAVAILABLE', 'unavailable')),
    ).toContain('rien n’a été modifié')
    expect(historyErrorMessage(new ApiError(404, 'E_VERSION_NOT_FOUND', 'Version not found'))).toBe(
      'Cette version n’existe plus : elle a peut-être été purgée.',
    )
  })
})
