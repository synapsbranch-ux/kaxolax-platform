import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Readable } from 'node:stream'
import { ZIP_IMPORT_LIMITS } from '@kaxolax/contracts'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import yazl from 'yazl'
import { detectCompiler, importZip, type StoreBinary, ZipImportError } from './index.js'

interface ZipEntry {
  name: string
  content?: string | Buffer
  directory?: boolean
  mode?: number
}

let directory: string
let counter = 0

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'kaxolax-zip-test-'))
})

afterAll(async () => {
  await rm(directory, { recursive: true, force: true })
})

async function zipBuffer(entries: ZipEntry[]): Promise<Buffer> {
  const zip = new yazl.ZipFile()
  for (const entry of entries) {
    if (entry.directory) zip.addEmptyDirectory(entry.name)
    else {
      const content =
        typeof entry.content === 'string'
          ? Buffer.from(entry.content)
          : (entry.content ?? Buffer.alloc(0))
      zip.addBuffer(content, entry.name, entry.mode === undefined ? {} : { mode: entry.mode })
    }
  }
  zip.end()
  const chunks: Buffer[] = []
  for await (const chunk of zip.outputStream) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks)
}

async function save(bytes: Buffer): Promise<string> {
  const path = join(directory, `${String(counter++)}.zip`)
  await writeFile(path, bytes)
  return path
}

const makeZip = async (entries: ZipEntry[]) => save(await zipBuffer(entries))

/** Remplace un nom d'entrée par un autre de même longueur (en-tête local et répertoire central). */
function renameEntry(bytes: Buffer, from: string, to: string): Buffer {
  expect(to.length).toBe(from.length)
  return Buffer.from(bytes.toString('latin1').replaceAll(from, to), 'latin1')
}

/** Réécrit la taille décompressée annoncée par le répertoire central (ce que lit yauzl). */
function declareUncompressedSize(bytes: Buffer, size: number): Buffer {
  const copy = Buffer.from(bytes)
  const offset = copy.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]))
  copy.writeUInt32LE(size, offset + 24)
  return copy
}

const sha256 = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex')

/** Stockage en mémoire des binaires, pour vérifier ce qui a été confié à S3. */
function memoryStore() {
  const stored = new Map<string, Buffer>()
  const store: StoreBinary<string> = async ({ path, body }: { path: string; body: Readable }) => {
    const chunks: Buffer[] = []
    for await (const chunk of body) chunks.push(chunk as Buffer)
    stored.set(path, Buffer.concat(chunks))
    return `key:${path}`
  }
  return { stored, store }
}

async function rejection(promise: Promise<unknown>): Promise<string> {
  try {
    await promise
  } catch (error) {
    expect(error).toBeInstanceOf(ZipImportError)
    return (error as ZipImportError).code
  }
  throw new Error('expected the import to be rejected')
}

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13])
const MAIN =
  '\\documentclass{article}\n\\begin{document}\n\\input{sections/intro}\n\\end{document}\n'

describe('importZip', () => {
  it('imports documents, binaries, folders and the main document of an exported project', async () => {
    const path = await makeZip([
      { name: 'main.tex', content: MAIN },
      { name: 'references.bib', content: '@book{knuth, title={The \\TeX book}}\n' },
      { name: 'sections/intro.tex', content: '\\section{Introduction} Voilà.\n' },
      { name: 'figures/plot.png', content: PNG },
      { name: 'notes/', directory: true },
    ])
    const { stored, store } = memoryStore()
    const result = await importZip(path, store)

    expect(result.folders).toEqual(['figures', 'notes', 'sections'])
    expect(result.documents.map((document) => document.path)).toEqual([
      'main.tex',
      'references.bib',
      'sections/intro.tex',
    ])
    expect(result.documents[2]).toEqual({
      path: 'sections/intro.tex',
      content: '\\section{Introduction} Voilà.\n',
      sha256: sha256('\\section{Introduction} Voilà.\n'),
    })
    expect(result.binaries).toEqual([
      {
        path: 'figures/plot.png',
        sha256: sha256(PNG),
        sizeBytes: PNG.length,
        mimeType: 'image/png',
        stored: 'key:figures/plot.png',
      },
    ])
    expect(stored.get('figures/plot.png')).toEqual(PNG)
    expect(result.mainDocumentPath).toBe('main.tex')
    expect(result.compiler).toBe('pdflatex')
  })

  it('picks the first uncommented \\documentclass when there is no main.tex', async () => {
    const path = await makeZip([
      { name: 'chapters/draft.tex', content: '\\documentclass{book}\n' },
      { name: 'old.tex', content: '% \\documentclass{article}\n' },
      { name: 'thesis.tex', content: '\\documentclass{report}\n\\usepackage{fontspec}\n' },
      { name: 'appendix.tex', content: '\\chapter{Annexe}\n' },
    ])
    const result = await importZip(path, memoryStore().store)
    expect(result.mainDocumentPath).toBe('thesis.tex')
    expect(result.compiler).toBe('xelatex')
  })

  it('imports the content of a single top-level folder at the project root', async () => {
    const path = await makeZip([
      { name: 'my-paper/', directory: true },
      { name: 'my-paper/main.tex', content: MAIN },
      { name: 'my-paper/img/a.png', content: PNG },
      { name: '__MACOSX/my-paper/._main.tex', content: 'junk' },
      { name: 'my-paper/.DS_Store', content: 'junk' },
    ])
    const result = await importZip(path, memoryStore().store)
    expect(result.folders).toEqual(['img'])
    expect(result.documents.map((document) => document.path)).toEqual(['main.tex'])
    expect(result.binaries.map((binary) => binary.path)).toEqual(['img/a.png'])
    expect(result.mainDocumentPath).toBe('main.tex')
  })

  it('stores text files that are not valid UTF-8 as binaries', async () => {
    const latin1 = Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a])
    const { stored, store } = memoryStore()
    const result = await importZip(await makeZip([{ name: 'legacy.tex', content: latin1 }]), store)
    expect(result.documents).toEqual([])
    expect(result.binaries[0]).toMatchObject({ path: 'legacy.tex', sha256: sha256(latin1) })
    expect(stored.get('legacy.tex')).toEqual(latin1)
    expect(result.mainDocumentPath).toBeNull()
  })

  it('rejects entries that escape the project: ../ and absolute paths', async () => {
    const base = await zipBuffer([
      { name: 'main.tex', content: MAIN },
      { name: 'xx/evil.tex', content: 'pwned' },
      { name: 'xetc/passwd', content: 'root' },
    ])
    expect(
      await rejection(
        importZip(await save(renameEntry(base, 'xx/evil.tex', '../evil.tex')), memoryStore().store),
      ),
    ).toBe('E_ZIP_UNSAFE_PATH')
    expect(
      await rejection(
        importZip(await save(renameEntry(base, 'xetc/passwd', '/etc/passwd')), memoryStore().store),
      ),
    ).toBe('E_ZIP_UNSAFE_PATH')
  })

  it('rejects symbolic links and invalid names', async () => {
    const link = await makeZip([{ name: 'link.tex', content: '/etc/passwd', mode: 0o120777 }])
    expect(await rejection(importZip(link, memoryStore().store))).toBe('E_ZIP_UNSAFE_PATH')
    const control = await makeZip([{ name: 'bad\u0007name.tex', content: 'x' }])
    expect(await rejection(importZip(control, memoryStore().store))).toBe('E_ZIP_INVALID_NAME')
  })

  it('rejects a zip bomb whose declared size is too large, before extracting anything', async () => {
    const { stored, store } = memoryStore()
    const small = await zipBuffer([{ name: 'bomb.bin', content: Buffer.alloc(1024) }])
    // Taille annoncée de 600 Mio avec les limites réelles (500 Mio décompressés).
    const bomb = await save(declareUncompressedSize(small, 600 * 1024 * 1024))
    expect(await rejection(importZip(bomb, store, ZIP_IMPORT_LIMITS))).toBe('E_ZIP_TOO_LARGE')
    expect(stored.size).toBe(0)

    const zeros = await makeZip([{ name: 'zeros.bin', content: Buffer.alloc(2 * 1024 * 1024) }])
    expect(
      await rejection(importZip(zeros, store, { maxFiles: 10, maxUncompressedBytes: 1024 * 1024 })),
    ).toBe('E_ZIP_TOO_LARGE')
  })

  it('rejects a zip bomb that lies about its uncompressed size, before storing anything', async () => {
    const { stored, store } = memoryStore()
    const honest = await zipBuffer([
      { name: 'figures/plot.png', content: PNG },
      { name: 'bomb.bin', content: Buffer.alloc(10 * 1024 * 1024) },
    ])
    // Deuxième entrée du répertoire central : 10 Mio annoncés comme 1 000 octets.
    const first = honest.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]))
    const second = honest.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]), first + 4)
    const lying = Buffer.from(honest)
    lying.writeUInt32LE(1000, second + 24)
    expect(await rejection(importZip(await save(lying), store))).toBe('E_ZIP_TOO_LARGE')
    // Le binaire valide qui précède la bombe n'a pas été envoyé au stockage.
    expect(stored.size).toBe(0)
  })

  it('rejects too many files, duplicate paths and file/folder conflicts', async () => {
    const many = await makeZip(
      ['a', 'b', 'c', 'd'].map((name) => ({ name: `${name}.tex`, content: name })),
    )
    expect(
      await rejection(
        importZip(many, memoryStore().store, { maxFiles: 3, maxUncompressedBytes: 1024 }),
      ),
    ).toBe('E_ZIP_TOO_MANY_FILES')
    const duplicate = await makeZip([
      { name: 'main.tex', content: 'a' },
      { name: 'main.tex', content: 'b' },
    ])
    expect(await rejection(importZip(duplicate, memoryStore().store))).toBe('E_ZIP_DUPLICATE_PATH')
    const conflict = await makeZip([
      { name: 'figures', content: 'a file' },
      { name: 'figures/a.png', content: PNG },
    ])
    expect(await rejection(importZip(conflict, memoryStore().store))).toBe('E_ZIP_DUPLICATE_PATH')
  })

  it('rejects files that are not zips and zips without files', async () => {
    const notZip = await save(Buffer.from('this is not a zip archive at all'))
    expect(await rejection(importZip(notZip, memoryStore().store))).toBe('E_ZIP_INVALID')
    const empty = await makeZip([{ name: 'empty/', directory: true }])
    expect(await rejection(importZip(empty, memoryStore().store))).toBe('E_ZIP_EMPTY')
  })

  it('uses the limits of the specification by default', () => {
    expect(ZIP_IMPORT_LIMITS).toEqual({ maxFiles: 5_000, maxUncompressedBytes: 500 * 1024 * 1024 })
  })
})

describe('detectCompiler', () => {
  it('detects XeLaTeX and LuaLaTeX packages, and ignores comments', () => {
    expect(detectCompiler('\\usepackage[no-math]{fontspec}')).toBe('xelatex')
    expect(detectCompiler('\\usepackage{amsmath, unicode-math}')).toBe('xelatex')
    expect(detectCompiler('\\usepackage{luacode}')).toBe('lualatex')
    expect(detectCompiler('\\directlua{tex.print("x")}')).toBe('lualatex')
    expect(detectCompiler('% \\usepackage{fontspec}\n\\usepackage[utf8]{inputenc}')).toBe(
      'pdflatex',
    )
    expect(detectCompiler(null)).toBe('pdflatex')
  })
})
