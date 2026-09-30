import { mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BinaryCache, ChecksumMismatchError } from '../../src/storage.js'
import { sha256Hex } from '../../src/workspace.js'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'kaxolax-cache-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('BinaryCache', () => {
  it('downloads once, verifies the hash and serves later requests from disk', async () => {
    let downloads = 0
    const cache = new BinaryCache(dir, () => {
      downloads++
      return Promise.resolve(Readable.from([Buffer.from('hello')]))
    })
    const sha = sha256Hex('hello')
    const [a, b] = await Promise.all([cache.get('k', sha), cache.get('k', sha)])
    expect(a).toBe(b)
    expect(await readFile(a, 'utf8')).toBe('hello')
    await cache.get('k', sha)
    expect(downloads).toBe(1)
  })

  it('refuses content whose hash does not match', async () => {
    const cache = new BinaryCache(dir, () => Promise.resolve(Readable.from([Buffer.from('evil')])))
    await expect(cache.get('k', sha256Hex('hello'))).rejects.toBeInstanceOf(ChecksumMismatchError)
    await expect(stat(cache.pathFor(sha256Hex('hello')))).rejects.toThrow()
  })

  it('evicts the least recently used files beyond the size limit', async () => {
    const cache = new BinaryCache(dir, () => Promise.reject(new Error('offline')))
    const source = join(dir, 'src')
    const shas = ['old', 'mid', 'new'].map((name) => sha256Hex(name))
    for (const [index, sha] of shas.entries()) {
      await writeFile(source, 'x'.repeat(100))
      await cache.put(source, sha)
      const time = new Date(Date.now() - (3 - index) * 60_000)
      await utimes(cache.pathFor(sha), time, time)
    }
    expect(await cache.prune(250)).toBe(1)
    await expect(stat(cache.pathFor(shas[0] ?? ''))).rejects.toThrow()
    await expect(stat(cache.pathFor(shas[2] ?? ''))).resolves.toBeTruthy()
  })
})
