import { describe, expect, it } from 'vitest'
import type { ProjectTree } from './api'
import { xsrfToken } from './api'
import { groupEntries, locationLabel } from './logs'
import { documentByPath, isInside, nestTree } from './tree'

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

describe('xsrfToken', () => {
  it('reads and decodes the XSRF-TOKEN cookie', () => {
    expect(xsrfToken('a=1; XSRF-TOKEN=abc%3D%3D; b=2')).toBe('abc==')
    expect(xsrfToken('a=1')).toBeNull()
  })
})
