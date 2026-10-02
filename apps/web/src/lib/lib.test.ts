import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ProjectTree } from './api'
import { api, ApiError, setTokenGetter } from './api'
import { groupEntries, locationLabel } from './logs'
import { documentByPath, isInside, nestTree, treeKeyEffect, visibleRows } from './tree'

const tree: ProjectTree = {
  mainDocumentId: 'd1',
  folders: [
    { id: 'f1', parentId: null, name: 'chapters', path: 'chapters' },
    { id: 'f2', parentId: 'f1', name: 'appendix', path: 'chapters/appendix' },
  ],
  documents: [
    { id: 'd1', folderId: null, name: 'main.tex', path: 'main.tex' },
    { id: 'd2', folderId: 'f1', name: 'intro.tex', path: 'chapters/intro.tex' },
  ],
  files: [
    { id: 'b1', folderId: null, name: 'a.png', path: 'a.png', sizeBytes: 3, mimeType: 'image/png' },
  ],
}

describe('tree', () => {
  it('nests folders first, then items by name', () => {
    const nested = nestTree(tree)
    expect(nested.map((node) => node.entity.name)).toEqual(['chapters', 'a.png', 'main.tex'])
    const chapters = nested[0]
    expect(
      chapters?.type === 'folder' && chapters.children.map((node) => node.entity.name),
    ).toEqual(['appendix', 'intro.tex'])
  })

  it('finds documents by path and detects folder cycles', () => {
    expect(documentByPath(tree, 'chapters/intro.tex')?.id).toBe('d2')
    expect(isInside(tree, 'f2', 'f1')).toBe(true)
    expect(isInside(tree, 'f1', 'f2')).toBe(false)
  })

  it('moves through visible rows with the keyboard', () => {
    const nodes = nestTree(tree)
    const rows = visibleRows(nodes, new Set())
    expect(rows.map((row) => row.node.entity.id)).toEqual(['f1', 'f2', 'd2', 'b1', 'd1'])
    expect(treeKeyEffect(rows, 'f1', 'ArrowDown')).toEqual({ kind: 'focus', id: 'f2' })
    expect(treeKeyEffect(rows, 'f1', 'ArrowUp')).toBeNull()
    expect(treeKeyEffect(rows, 'd2', 'ArrowLeft')).toEqual({ kind: 'focus', id: 'f1' })
    expect(treeKeyEffect(rows, 'f1', 'ArrowLeft')).toEqual({ kind: 'toggle', id: 'f1' })
    expect(treeKeyEffect(rows, 'f1', 'ArrowRight')).toEqual({ kind: 'focus', id: 'f2' })
    expect(treeKeyEffect(rows, 'd1', 'Enter')).toEqual({ kind: 'open', id: 'd1' })
    expect(treeKeyEffect(rows, 'b1', 'End')).toEqual({ kind: 'focus', id: 'd1' })

    const folded = visibleRows(nodes, new Set(['f1']))
    expect(folded.map((row) => row.node.entity.id)).toEqual(['f1', 'b1', 'd1'])
    expect(treeKeyEffect(folded, 'f1', 'ArrowRight')).toEqual({ kind: 'toggle', id: 'f1' })
  })
})

describe('logs', () => {
  it('groups entries by level and labels their location', () => {
    const grouped = groupEntries([
      { level: 'warning', file: 'main.tex', line: 4, message: 'w', raw: '' },
      { level: 'error', file: 'main.tex', line: 7, message: 'e', raw: '' },
      { level: 'typesetting', file: null, line: null, message: 't', raw: '' },
    ])
    expect([grouped.errors.length, grouped.warnings.length, grouped.typesetting.length]).toEqual([
      1, 1, 1,
    ])
    const [error] = grouped.errors
    const [typesetting] = grouped.typesetting
    expect(error && locationLabel(error)).toBe('main.tex:7')
    expect(typesetting && locationLabel(typesetting)).toBeNull()
  })
})

describe('api client', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('waits for Clerk, then sends a fresh session token and no cookie', async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve(new Response(JSON.stringify({ user: { id: 'u1' } }), { status: 200 })),
    )
    vi.stubGlobal('fetch', fetchMock)
    const pending = api.me()
    // Pas de requête tant que Clerk n'a pas fourni son jeton.
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(fetchMock).not.toHaveBeenCalled()

    let calls = 0
    setTokenGetter(() => Promise.resolve(`token-${String(++calls)}`))
    await expect(pending).resolves.toEqual({ user: { id: 'u1' } })
    await api.me()
    const requests = fetchMock.mock.calls as unknown as [string, RequestInit][]
    expect(requests.map(([url]) => url)).toEqual(['/api/v1/me', '/api/v1/me'])
    expect(
      requests.map(([, init]) => (init.headers as Record<string, string>).authorization),
    ).toEqual(['Bearer token-1', 'Bearer token-2'])
    expect(requests[0]?.[1].credentials).toBe('omit')
  })

  it('turns an error response into an ApiError', async () => {
    setTokenGetter(() => Promise.resolve(null))
    vi.stubGlobal('fetch', () =>
      Promise.resolve(
        new Response(JSON.stringify({ code: 'E_UNAUTHORIZED_ACCESS', message: 'Unauthorized' }), {
          status: 401,
        }),
      ),
    )
    const error = await api.me().catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(ApiError)
    expect(error).toMatchObject({ status: 401, code: 'E_UNAUTHORIZED_ACCESS' })
  })
})
