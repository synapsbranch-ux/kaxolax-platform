import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { INTERNAL_TOKEN_HEADER, type WordCountRequest } from '@kaxolax/contracts'
import { pino } from 'pino'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { pruneProjects } from '../../src/cleanup.js'
import {
  Compiler,
  WORD_COUNT_DIR,
  WORD_COUNT_MAX_WAITING,
  WordCountBusyError,
  WordCountError,
} from '../../src/compiler.js'
import {
  type CompileSandbox,
  type SandboxResult,
  type SandboxRunRequest,
} from '../../src/sandbox.js'
import { buildServer } from '../../src/server.js'
import { LocalOutputStore } from '../../src/storage.js'
import { parseTexcountOutput, TEXCOUNT_GUARD, texcountCommand } from '../../src/texcount.js'

const projectId = '6f1c2d3e-4b5a-4c7d-8e9f-0a1b2c3d4e5f'
const sha = 'a'.repeat(64)

/** Sortie réelle de texcount 3.1.1 (TeX Live 2026), `-merge -sub=section -utf8 -nocol`. */
const MERGED_OUTPUT = `Possible precedence problem between ! and pattern match (m//) at /usr/local/texlive/2026/bin/x86_64-linux/texcount line 1430.
Possible precedence problem between ! and pattern match (m//) at /usr/local/texlive/2026/bin/x86_64-linux/texcount line 2861.
File: main.tex
Words in text: 26
Words in headers: 11
Words outside text (captions, etc.): 8
Number of headers: 5
Number of floats/tables/figures: 2
Number of math inlines: 1
Number of math displayed: 1
Subcounts:
  text+headers+captions (#headers/#floats/#inlines/#displayed)
  0+4+0 (1/0/0/0) _top_
  11+2+6 (1/1/1/1) Section: Introduction générale
  8+2+2 (1/1/0/0) Section: Chapitre inclus
  7+3+0 (2/0/0/0) Section: Sans numéro
`

/** Document cassé : avertissements `!!! … !!!` et compteur d'erreurs. */
const BROKEN_OUTPUT = `!!! File absent.tex not found in path [./]. !!!

!!! Reached end of file while waiting for }. !!!

!!! Reached end of file while waiting for }. !!!
File: main.tex
Words in text: 9
Words in headers: 3
Words outside text (captions, etc.): 0
Number of headers: 3
Number of floats/tables/figures: 0
Number of math inlines: 0
Number of math displayed: 0
Subcounts:
  text+headers+captions (#headers/#floats/#inlines/#displayed)
  3+1+0 (1/0/0/0) Chapter: Premier
  4+1+0 (1/0/0/0) Section: Sous: titre
  2+1+0 (1/0/0/0) Chapter: Second

(errors:3)
`

/** Sans -merge : un bloc par fichier, puis « File(s) total » et un détail par fichier. */
const PER_FILE_OUTPUT = `File: main.tex
Words in text: 18
Words in headers: 9
Words outside text (captions, etc.): 6
Number of headers: 4
Number of floats/tables/figures: 1
Number of math inlines: 1
Number of math displayed: 1

Sum of files: main.tex
File(s) total: main.tex
Words in text: 26
Words in headers: 11
Words outside text (captions, etc.): 8
Number of headers: 5
Number of floats/tables/figures: 2
Number of math inlines: 1
Number of math displayed: 1
Files: 2
Subcounts:
  text+headers+captions (#headers/#floats/#inlines/#displayed)
  18+9+6 (4/1/1/1) File: main.tex
  8+2+2 (1/1/0/0) Included file: ./chapters/intro.tex
`

describe('parseTexcountOutput', () => {
  it('reads the totals and the sections of a merged count', () => {
    const result = parseTexcountOutput(MERGED_OUTPUT)
    expect(result.total).toEqual({
      words: 45,
      text: 26,
      headers: 11,
      captions: 8,
      headerCount: 5,
      floatCount: 2,
      inlineMathCount: 1,
      displayMathCount: 1,
    })
    expect(result.sections.map((section) => [section.kind, section.title, section.words])).toEqual([
      ['top', '', 4],
      ['section', 'Introduction générale', 19],
      ['section', 'Chapitre inclus', 12],
      ['section', 'Sans numéro', 10],
    ])
    expect(result.sections[1]).toMatchObject({
      text: 11,
      headers: 2,
      captions: 6,
      headerCount: 1,
      floatCount: 1,
      inlineMathCount: 1,
      displayMathCount: 1,
    })
    expect(result.warnings).toEqual([])
  })

  it('keeps distinct texcount warnings and section titles containing a colon', () => {
    const result = parseTexcountOutput(BROKEN_OUTPUT)
    expect(result.warnings).toEqual([
      'File absent.tex not found in path [./].',
      'Reached end of file while waiting for }.',
    ])
    expect(result.sections.map((section) => [section.kind, section.title])).toEqual([
      ['chapter', 'Premier'],
      ['section', 'Sous: titre'],
      ['chapter', 'Second'],
    ])
    expect(result.total.words).toBe(12)
  })

  it('uses the last totals block and ignores per-file subcounts', () => {
    const result = parseTexcountOutput(PER_FILE_OUTPUT)
    expect(result.total.text).toBe(26)
    expect(result.sections).toEqual([])
  })

  it('fails without totals, with the texcount message', () => {
    expect(() =>
      parseTexcountOutput('!!! File not found or not readable: main.tex !!!\n(errors:1)\n'),
    ).toThrow('File not found or not readable: main.tex')
    expect(() => parseTexcountOutput('')).toThrow('texcount produced no word count')
  })

  it('classifies unknown section labels as other', () => {
    const output = `Words in text: 1\nWords in headers: 0\nWords outside text (captions, etc.): 0\nSubcounts:\n  1+0+0 (0/0/0/0) Frame: Diapositive\n`
    expect(parseTexcountOutput(output).sections).toEqual([
      expect.objectContaining({ kind: 'other', title: 'Frame: Diapositive', words: 1 }),
    ])
  })
})

describe('texcountCommand', () => {
  it('runs texcount under the read guard, and never lets the file name become an option', () => {
    expect(texcountCommand('-v.tex', '/compile')).toEqual([
      'perl',
      '-e',
      TEXCOUNT_GUARD,
      '--',
      '/compile',
      '-merge',
      '-sub=section',
      '-utf8',
      '-nocol',
      './-v.tex',
    ])
    // La garde vise la seule fonction de lecture de texcount, et échoue sans elle.
    expect(TEXCOUNT_GUARD).toContain('sub read_binary')
    expect(TEXCOUNT_GUARD).toContain('unsupported texcount version')
  })
})

/** Faux sandbox : vérifie les fichiers visibles par texcount et rend une sortie fixée. */
class FakeSandbox implements CompileSandbox {
  runs: SandboxRunRequest[] = []
  seen: Record<string, string> = {}
  result: Partial<SandboxResult> = {}

  constructor(readonly serialRuns = false) {}

  workdirPath(hostWorkdir: string) {
    return hostWorkdir
  }

  async run(run: SandboxRunRequest): Promise<SandboxResult> {
    this.runs.push(run)
    const files = await readdir(run.hostWorkdir, { recursive: true, withFileTypes: true })
    for (const file of files.filter((entry) => entry.isFile())) {
      const path = join(file.parentPath, file.name)
      this.seen[path.slice(run.hostWorkdir.length + 1)] = await readFile(path, 'utf8')
    }
    return {
      outcome: 'exited',
      exitCode: 0,
      oomKilled: false,
      killReason: null,
      durationMs: 1,
      output: MERGED_OUTPUT,
      ...this.result,
    }
  }
}

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'kaxolax-wordcount-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

function compiler(sandbox: CompileSandbox) {
  return new Compiler({
    agentId: 'test',
    compilesDir: join(dir, 'compiles'),
    capacity: 1,
    workdirMaxBytes: 10 * 1024 * 1024,
    outputBucket: 'kaxolax-compile-outputs',
    sandbox,
    binaries: { get: () => Promise.reject(new Error('no binaries')) },
    outputs: new LocalOutputStore(join(dir, 'outputs')),
    logger: { info: () => undefined, warn: () => undefined },
  })
}

function request(overrides: Partial<WordCountRequest> = {}): WordCountRequest {
  return {
    projectId,
    rootResourcePath: 'thesis/main.tex',
    resources: [
      { path: 'thesis/main.tex', kind: 'text', content: '\\input{chapters/a}', sha256: sha },
      { path: 'thesis/chapters/a.tex', kind: 'text', content: 'Bonjour le monde.', sha256: sha },
    ],
    ...overrides,
  }
}

describe('Compiler.wordCount', () => {
  it('runs texcount read-only in the directory of the main document, then cleans up', async () => {
    const sandbox = new FakeSandbox()
    const result = await compiler(sandbox).wordCount(request())
    expect(result.total.words).toBe(45)
    const [run] = sandbox.runs
    expect(run?.command).toEqual(texcountCommand('main.tex', run?.hostWorkdir ?? ''))
    expect(run?.readOnly).toBe(true)
    expect(run?.timeoutMs).toBe(20_000)
    expect(run?.workingDir).toBe(`${run?.hostWorkdir ?? ''}/thesis`)
    expect(sandbox.seen).toEqual({
      'thesis/main.tex': '\\input{chapters/a}',
      'thesis/chapters/a.tex': 'Bonjour le monde.',
    })
    // Répertoire temporaire (hors du projet) supprimé ; le répertoire du projet n'est pas créé.
    expect(run?.hostWorkdir.startsWith(join(dir, 'compiles', WORD_COUNT_DIR))).toBe(true)
    expect(await readdir(join(dir, 'compiles'))).toEqual([WORD_COUNT_DIR])
    expect(await readdir(join(dir, 'compiles', WORD_COUNT_DIR))).toEqual([])
  })

  it('is not disturbed by a cache clear or a cleanup of the projects during the count', async () => {
    const instance = compiler(new FakeSandbox())
    const sandbox = new FakeSandbox()
    const counting = compiler(sandbox)
    // Pendant texcount : vidage du cache du projet et nettoyage LRU de tous les projets.
    const run = sandbox.run.bind(sandbox)
    sandbox.run = async (request) => {
      await instance.clearCache(projectId)
      await pruneProjects(join(dir, 'compiles'), { maxProjects: 0, maxBytes: 0 }, () => false)
      return run(request)
    }
    const result = await counting.wordCount(request())
    expect(result.total.words).toBe(45)
    expect(sandbox.seen['thesis/chapters/a.tex']).toBe('Bonjour le monde.')
  })

  it('reports a timeout or unreadable output as a word count error', async () => {
    const sandbox = new FakeSandbox()
    sandbox.result = { outcome: 'timeout' }
    await expect(compiler(sandbox).wordCount(request())).rejects.toThrow(WordCountError)
    sandbox.result = { output: '!!! File not found or not readable: ./main.tex !!!' }
    await expect(compiler(sandbox).wordCount(request())).rejects.toThrow(
      'File not found or not readable',
    )
    expect(await readdir(join(dir, 'compiles', WORD_COUNT_DIR))).toEqual([])
  })

  it('waits for the running compile when the sandbox runs one command at a time', async () => {
    const sandbox = new FakeSandbox(true)
    const instance = compiler(sandbox)
    // La capacité de compilation (1) est occupée : le comptage attend.
    const slots = (instance as unknown as { slots: { acquire(): Promise<() => void> } }).slots
    const release = await slots.acquire()
    let done = false
    const counting = instance.wordCount(request()).then(() => {
      done = true
    })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(done).toBe(false)
    release()
    await counting
    expect(done).toBe(true)
  })
})

describe('Compiler.wordCount queue', () => {
  it('refuses a word count at once when too many are already waiting for a slot', async () => {
    const sandbox = new FakeSandbox(true)
    const instance = compiler(sandbox)
    const slots = (instance as unknown as { slots: { acquire(): Promise<() => void> } }).slots
    const release = await slots.acquire()
    const waiting = Array.from({ length: WORD_COUNT_MAX_WAITING }, () =>
      instance.wordCount(request()),
    )
    await expect(instance.wordCount(request())).rejects.toThrow(WordCountBusyError)

    // Route HTTP : 503, l'API répond « service indisponible ».
    const token = 'x'.repeat(40)
    const app = buildServer({
      compiler: instance,
      internalToken: token,
      logger: pino({ level: 'silent' }),
    })
    const busy = await app.inject({
      method: 'POST',
      url: `/projects/${projectId}/word-count`,
      headers: { [INTERNAL_TOKEN_HEADER]: token },
      payload: request(),
    })
    expect(busy.statusCode).toBe(503)
    expect(busy.json()).toMatchObject({ error: 'word_count_busy' })

    release()
    const results = await Promise.all(waiting)
    expect(results).toHaveLength(WORD_COUNT_MAX_WAITING)
    // File vidée : un nouveau comptage est de nouveau accepté.
    expect((await instance.wordCount(request())).total.words).toBe(45)
  })
})

describe('agent HTTP word count route', () => {
  const token = 'x'.repeat(40)
  const headers = { [INTERNAL_TOKEN_HEADER]: token }
  const logger = pino({ level: 'silent' })

  it('validates the request and maps word count errors to 422', async () => {
    const sandbox = new FakeSandbox()
    const app = buildServer({ compiler: compiler(sandbox), internalToken: token, logger })
    const url = `/projects/${projectId}/word-count`
    const ok = await app.inject({ method: 'POST', url, headers, payload: request() })
    expect(ok.statusCode).toBe(200)
    expect(ok.json()).toMatchObject({ total: { words: 45 }, warnings: [] })

    const mismatch = await app.inject({
      method: 'POST',
      url: `/projects/0b8f7e6d-5c4b-4a39-8281-7f6e5d4c3b2a/word-count`,
      headers,
      payload: request(),
    })
    expect(mismatch.statusCode).toBe(400)

    const unsafe = request({ rootResourcePath: '../main.tex' })
    expect((await app.inject({ method: 'POST', url, headers, payload: unsafe })).statusCode).toBe(
      400,
    )

    sandbox.result = { outcome: 'timeout' }
    const failed = await app.inject({ method: 'POST', url, headers, payload: request() })
    expect(failed.statusCode).toBe(422)
    expect(failed.json()).toEqual({ error: 'word_count_failed', message: 'Word count timed out' })
    expect(sandbox.runs).toHaveLength(2)
  })
})
