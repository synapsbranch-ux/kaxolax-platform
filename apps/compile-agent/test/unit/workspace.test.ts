import { mkdtemp, mkdir, readFile, rm, symlink, writeFile, readdir, lstat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type CompileResource } from '@kaxolax/contracts'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  assertSafeTarget,
  type BinarySource,
  projectPaths,
  sha256Hex,
  syncWorkspace,
  UnsafePathError,
} from '../../src/workspace.js'

let root: string
let outside: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'kaxolax-ws-'))
  outside = await mkdtemp(join(tmpdir(), 'kaxolax-outside-'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
  await rm(outside, { recursive: true, force: true })
})

const text = (path: string, content: string): CompileResource => ({
  path,
  kind: 'text',
  content,
  sha256: sha256Hex(content),
})

function fakeBinaries(files: Record<string, string>): BinarySource & { calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    get: (s3Key) => {
      calls.push(s3Key)
      const path = files[s3Key]
      if (path === undefined) throw new Error(`unknown ${s3Key}`)
      return Promise.resolve(path)
    },
  }
}

const noBinaries = fakeBinaries({})

describe('syncWorkspace', () => {
  it('writes only changed files and removes deleted resources, keeping generated files', async () => {
    const paths = projectPaths(root, 'p1')
    const first = await syncWorkspace(
      paths,
      [text('main.tex', 'A'), text('chapters/intro.tex', 'B')],
      noBinaries,
      'main.tex',
    )
    expect(first).toMatchObject({ written: 2, unchanged: 0, deleted: 0 })
    // Fichier généré par une compilation : il doit survivre à la synchronisation suivante.
    await writeFile(join(paths.files, 'output.aux'), 'aux')

    const second = await syncWorkspace(paths, [text('main.tex', 'A2')], noBinaries, 'main.tex')
    expect(second).toMatchObject({ written: 1, unchanged: 0, deleted: 1 })
    expect(await readFile(join(paths.files, 'main.tex'), 'utf8')).toBe('A2')
    expect(await readFile(join(paths.files, 'output.aux'), 'utf8')).toBe('aux')
    await expect(lstat(join(paths.files, 'chapters'))).rejects.toThrow()

    const third = await syncWorkspace(paths, [text('main.tex', 'A2')], noBinaries, 'main.tex')
    expect(third).toMatchObject({ written: 0, unchanged: 1, deleted: 0 })
  })

  it('rewrites a resource that a compilation overwrote', async () => {
    const paths = projectPaths(root, 'p1')
    await syncWorkspace(paths, [text('main.tex', 'original')], noBinaries, 'main.tex')
    await writeFile(join(paths.files, 'main.tex'), 'tampered by \\openout')
    const stats = await syncWorkspace(paths, [text('main.tex', 'original')], noBinaries, 'main.tex')
    expect(stats.written).toBe(1)
    expect(await readFile(join(paths.files, 'main.tex'), 'utf8')).toBe('original')
  })

  it('copies binaries from the cache only when their hash changes', async () => {
    const paths = projectPaths(root, 'p1')
    const cached = join(outside, 'blob')
    await writeFile(cached, 'PNGDATA')
    const binaries = fakeBinaries({ 'projects/p1/a': cached })
    const image: CompileResource = {
      path: 'figures/plot.png',
      kind: 'binary',
      s3Key: 'projects/p1/a',
      sha256: sha256Hex('PNGDATA'),
    }
    await syncWorkspace(paths, [text('main.tex', 'x'), image], binaries, 'main.tex')
    await syncWorkspace(paths, [text('main.tex', 'x'), image], binaries, 'main.tex')
    expect(binaries.calls).toEqual(['projects/p1/a'])
    expect(await readFile(join(paths.files, 'figures/plot.png'), 'utf8')).toBe('PNGDATA')
  })

  it('rejects, before any write, a path that traverses a symbolic link', async () => {
    const paths = projectPaths(root, 'p1')
    await syncWorkspace(paths, [text('main.tex', 'x')], noBinaries, 'main.tex')
    // Un document malveillant aurait remplacé un dossier par un lien vers l'extérieur.
    await symlink(outside, join(paths.files, 'chapters'))
    await expect(
      syncWorkspace(
        paths,
        [text('main.tex', 'changed'), text('chapters/pwned.tex', 'escaped')],
        noBinaries,
        'main.tex',
      ),
    ).rejects.toBeInstanceOf(UnsafePathError)
    expect(await readdir(outside)).toEqual([])
    // Aucune écriture n'a eu lieu, même pour les ressources sûres.
    expect(await readFile(join(paths.files, 'main.tex'), 'utf8')).toBe('x')
  })

  it('never follows a symbolic link on the file itself', async () => {
    const paths = projectPaths(root, 'p1')
    await syncWorkspace(paths, [text('main.tex', 'x')], noBinaries, 'main.tex')
    await symlink(join(outside, 'target.tex'), join(paths.files, 'other.tex'))
    await expect(
      syncWorkspace(paths, [text('main.tex', 'x'), text('other.tex', 'y')], noBinaries, 'main.tex'),
    ).rejects.toBeInstanceOf(UnsafePathError)
    expect(await readdir(outside)).toEqual([])
  })

  it('refuses absolute paths and parent traversal', async () => {
    const paths = projectPaths(root, 'p1')
    await mkdir(paths.files, { recursive: true })
    for (const bad of ['/etc/passwd', '../escape.tex', 'a/../../b.tex']) {
      await expect(assertSafeTarget(paths.files, bad)).rejects.toBeInstanceOf(UnsafePathError)
    }
  })

  it('keeps its state outside the directory mounted in the container', async () => {
    const paths = projectPaths(root, 'p1')
    await syncWorkspace(paths, [text('main.tex', 'x')], noBinaries, 'thesis/main.tex')
    expect((await readdir(paths.root)).sort()).toEqual(['files', 'state.json'])
    expect(await readdir(paths.files)).toEqual(['main.tex'])
  })
})
