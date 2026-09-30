import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { pruneProjects } from '../../src/cleanup.js'
import { demultiplex } from '../../src/docker.js'
import { Semaphore } from '../../src/semaphore.js'
import {
  parseSynctexEdit,
  parseSynctexView,
  relativeToRoot,
  rootDirectory,
} from '../../src/synctex.js'

describe('synctex output', () => {
  it('parses synctex view records', () => {
    const output = [
      'This is SyncTeX command line utility, version 1.5',
      'SyncTeX result begin',
      'Output:/compile/output.pdf',
      'Page:1',
      'x:148.71',
      'y:130.76',
      'h:133.768356',
      'v:307.480713',
      'W:343.711060',
      'H:8.798183',
      'before:',
      'offset:0',
      'Output:/compile/output.pdf',
      'Page:2',
      'h:10',
      'v:20',
      'W:30',
      'H:40',
      'SyncTeX result end',
    ].join('\n')
    expect(parseSynctexView(output)).toEqual([
      { page: 1, h: 133.768356, v: 307.480713, width: 343.71106, height: 8.798183 },
      { page: 2, h: 10, v: 20, width: 30, height: 40 },
    ])
  })

  it('parses synctex edit records into project paths', () => {
    const output = [
      'SyncTeX result begin',
      'Output:/compile/thesis/output.pdf',
      'Input:/compile/thesis/./chapters/intro.tex',
      'Line:4',
      'Column:-1',
      'Offset:0',
      'Context:',
      'SyncTeX result end',
    ].join('\n')
    expect(parseSynctexEdit(output, 'thesis')).toEqual([
      { file: 'thesis/chapters/intro.tex', line: 4, column: 0 },
    ])
  })

  it('returns nothing without a result block', () => {
    expect(parseSynctexView('SyncTeX ERROR: No file?')).toEqual([])
    expect(parseSynctexEdit('', '')).toEqual([])
  })

  it('computes paths relative to the main document directory', () => {
    expect(rootDirectory('main.tex')).toBe('')
    expect(rootDirectory('thesis/main.tex')).toBe('thesis')
    expect(relativeToRoot('thesis/ch/a.tex', 'thesis')).toBe('ch/a.tex')
    expect(relativeToRoot('ch/a.tex', '')).toBe('ch/a.tex')
  })
})

describe('Semaphore', () => {
  it('limits concurrency and hands slots over in order', async () => {
    const semaphore = new Semaphore(1)
    const order: string[] = []
    const releaseA = await semaphore.acquire()
    const b = semaphore.acquire().then((release) => {
      order.push('b')
      return release
    })
    expect(semaphore.waiting).toBe(1)
    order.push('a done')
    releaseA()
    const releaseB = await b
    expect(order).toEqual(['a done', 'b'])
    releaseB()
    releaseB()
    expect(semaphore.active).toBe(0)
  })
})

describe('pruneProjects', () => {
  it('removes the least recently used projects first and skips busy ones', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kaxolax-prune-'))
    try {
      for (const [index, id] of ['oldest', 'busy', 'recent'].entries()) {
        await mkdir(join(dir, id, 'files'), { recursive: true })
        await writeFile(join(dir, id, 'files', 'f'), 'x'.repeat(10))
        await writeFile(
          join(dir, id, 'state.json'),
          JSON.stringify({ resources: {}, lastUsedAt: index }),
        )
      }
      const result = await pruneProjects(
        dir,
        { maxProjects: 2, maxBytes: 1e9 },
        (id) => id === 'busy',
      )
      expect(result.removed).toEqual(['oldest'])
      expect((await readdir(dir)).sort()).toEqual(['busy', 'recent'])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('demultiplex', () => {
  it('strips Docker stream headers', () => {
    const frame = (stream: number, text: string) => {
      const payload = Buffer.from(text)
      const header = Buffer.alloc(8)
      header[0] = stream
      header.writeUInt32BE(payload.length, 4)
      return Buffer.concat([header, payload])
    }
    expect(demultiplex(Buffer.concat([frame(1, 'out '), frame(2, 'err')]))).toBe('out err')
  })
})

describe('pruneProjects with a busy project', () => {
  it('keeps a busy project even if it is the least recently used', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kaxolax-prune-'))
    try {
      for (const [index, id] of ['busy', 'recent'].entries()) {
        await mkdir(join(dir, id, 'files'), { recursive: true })
        await writeFile(
          join(dir, id, 'state.json'),
          JSON.stringify({ resources: {}, lastUsedAt: index }),
        )
      }
      const result = await pruneProjects(
        dir,
        { maxProjects: 1, maxBytes: 1e9 },
        (id) => id === 'busy',
      )
      expect(result.removed).toEqual(['recent'])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
