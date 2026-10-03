import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  type ConvertRequest,
  convertResultSchema,
  INTERNAL_TOKEN_HEADER,
  MAX_CONVERT_EMBEDDED_IMAGES,
} from '@kaxolax/contracts'
import { pino } from 'pino'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  Compiler,
  CONVERT_DIR,
  ConvertBusyError,
  WORD_COUNT_MAX_WAITING,
} from '../../src/compiler.js'
import {
  CONVERT_FILES,
  convertCommand,
  ConvertError,
  convertFailure,
  describeImages,
  dropUnusedCitationSetup,
  filterOptions,
  type FilterOptions,
  parsePandocWarnings,
  parseReport,
  resolveConvertOptions,
  sensitiveCommandsWarning,
  splitLatex,
} from '../../src/convert.js'
import {
  type CompileSandbox,
  type SandboxResult,
  type SandboxRunRequest,
} from '../../src/sandbox.js'
import { buildServer } from '../../src/server.js'
import { LocalOutputStore } from '../../src/storage.js'

const projectId = '6f1c2d3e-4b5a-4c7d-8e9f-0a1b2c3d4e5f'
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])
const PNG_NAME = `${createHash('sha1').update(PNG).digest('hex')}.png`

function request(overrides: Partial<ConvertRequest> = {}): ConvertRequest {
  return {
    projectId,
    sourcePath: 'notes/intro.md',
    targetPath: 'chapters/intro.tex',
    markdown: '# Bonjour\n\n![figure](img/plot.png)\n',
    media: ['notes/img/plot.png'],
    ...overrides,
  }
}

/** Sortie de pandoc (modèle LaTeX par défaut, abrégé) autour du corps marqué par le filtre. */
function pandocOutput(marker: string, body: string, title = false): string {
  return [
    '% Options for packages loaded elsewhere',
    '\\PassOptionsToPackage{unicode}{hyperref}',
    '\\documentclass[',
    ']{article}',
    '\\usepackage{amsmath,amssymb}',
    '\\usepackage{graphicx}',
    '\\setcounter{secnumdepth}{5}',
    '\\makeatletter',
    '\\newsavebox\\pandoc@box',
    '\\makeatother',
    ...(title ? ['\\title{Titre}'] : []),
    '\\author{}',
    '\\date{}',
    '',
    '\\begin{document}',
    ...(title ? ['\\maketitle'] : []),
    '',
    `%KAXOLAX-BODY-BEGIN-${marker}`,
    '',
    body,
    '',
    `%KAXOLAX-BODY-END-${marker}`,
    '',
    '\\end{document}',
    '',
  ].join('\n')
}

/**
 * Faux sandbox : relit le répertoire préparé par l'agent puis joue pandoc et le filtre (sortie,
 * rapport, images extraites), ou un comportement choisi par le test.
 */
class FakeSandbox implements CompileSandbox {
  runs: SandboxRunRequest[] = []
  seen: Record<string, string> = {}
  filter: FilterOptions | null = null
  result: Partial<SandboxResult> = {}
  body = '\\section{Bonjour}\\label{bonjour}\n\n\\includegraphics{../notes/img/plot.png}'
  report: unknown = {
    title: 'Titre',
    images: [{ source: 'img/plot.png', kind: 'project', path: 'notes/img/plot.png' }],
  }
  /** Modifie le répertoire après « pandoc » (sorties piégées, fichiers démesurés). */
  tamper: ((directory: string) => Promise<void>) | null = null

  constructor(readonly serialRuns = false) {}

  workdirPath(hostWorkdir: string) {
    return hostWorkdir
  }

  async run(run: SandboxRunRequest): Promise<SandboxResult> {
    this.runs.push(run)
    const directory = run.hostWorkdir
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      this.seen[entry.name] = entry.isFile()
        ? await readFile(join(directory, entry.name), 'utf8')
        : 'directory'
    }
    this.filter = JSON.parse(this.seen[CONVERT_FILES.options] ?? '{}') as FilterOptions
    await writeFile(
      join(directory, CONVERT_FILES.output),
      pandocOutput(this.filter.marker, this.body, true),
    )
    await writeFile(join(directory, CONVERT_FILES.report), JSON.stringify(this.report))
    await writeFile(join(directory, CONVERT_FILES.media, PNG_NAME), PNG)
    await this.tamper?.(directory)
    return {
      outcome: 'exited',
      exitCode: 0,
      oomKilled: false,
      killReason: null,
      durationMs: 1,
      output: '',
      ...this.result,
    }
  }
}

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'kaxolax-convert-'))
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

describe('convertCommand', () => {
  it('is constant apart from closed lists, sandboxed, with the image filter only', () => {
    expect(convertCommand(resolveConvertOptions(request()))).toEqual([
      'pandoc',
      '+RTS',
      '-M512m',
      '-RTS',
      '--sandbox',
      '--data-dir=/usr/share/kaxolax/pandoc',
      '--lua-filter=/usr/share/kaxolax/pandoc/kaxolax-convert.lua',
      '--from=markdown-raw_tex-raw_attribute-raw_html',
      '--to=latex',
      '--standalone',
      '--wrap=preserve',
      '--variable=documentclass:article',
      '--natbib',
      '--output=output.tex',
      'input.md',
    ])
    const command = convertCommand(
      resolveConvertOptions(
        request({
          options: {
            mode: 'fragment',
            documentClass: 'scrbook',
            topLevelDivision: 'chapter',
            numberSections: true,
            citations: 'biblatex',
            rawLatex: true,
          },
        }),
      ),
    )
    expect(command).toContain('--from=markdown')
    expect(command).toContain('--biblatex')
    expect(command).not.toContain('--natbib')
    expect(command.join(' ')).not.toContain('citeproc')
    expect(command).toContain('--variable=documentclass:scrbook')
    expect(command).toContain('--top-level-division=chapter')
    expect(command).toContain('--number-sections')
    expect(command.filter((arg) => arg.includes('filter'))).toEqual([
      '--lua-filter=/usr/share/kaxolax/pandoc/kaxolax-convert.lua',
    ])
    // Rien de la demande (chemins, Markdown) n'entre dans la commande.
    expect(command.join(' ')).not.toMatch(/notes|chapters|Bonjour/)
    // Fragment : numéroté, pour que le préambule ne touche pas à la numérotation de l'hôte.
    expect(
      convertCommand(resolveConvertOptions(request({ options: { mode: 'fragment' } }))),
    ).toContain('--number-sections')
  })
})

describe('filterOptions', () => {
  it('derives the directories from the source and the target', () => {
    const options = resolveConvertOptions(request())
    expect(filterOptions(request(), options, 'ab')).toEqual({
      sourceDir: 'notes',
      graphicsDir: 'chapters',
      mediaDir: 'chapters/media',
      maxEmbedded: MAX_CONVERT_EMBEDDED_IMAGES,
      marker: 'ab',
      fragment: false,
    })
    expect(
      filterOptions(
        request({ sourcePath: 'a.md', targetPath: 'b.tex', graphicsDir: '', mediaDir: 'figures' }),
        resolveConvertOptions(request({ options: { mode: 'fragment' } })),
        'cd',
      ),
    ).toMatchObject({ sourceDir: '', graphicsDir: '', mediaDir: 'figures', fragment: true })
    expect(filterOptions(request({ targetPath: 'main.tex' }), options, 'ef').mediaDir).toBe('media')
  })
})

describe('splitLatex', () => {
  it('returns the whole document without the markers', () => {
    const { latex, preamble } = splitLatex(pandocOutput('m1', 'Corps.', true), 'm1', 'document')
    expect(preamble).toBeNull()
    expect(latex).toContain('\\documentclass[')
    expect(latex).toContain('\\maketitle')
    expect(latex).toContain('Corps.')
    expect(latex).not.toContain('KAXOLAX')
  })

  it('returns the body and the preamble of a fragment', () => {
    const { latex, preamble } = splitLatex(pandocOutput('m2', 'Corps.'), 'm2', 'fragment')
    expect(latex).toBe('Corps.\n')
    expect(preamble).toContain('\\usepackage{graphicx}')
    expect(preamble).toContain('\\newsavebox\\pandoc@box')
    expect(preamble).not.toMatch(/documentclass|\\author|\\date|secnumdepth|begin\{document\}/)
  })

  it('ignores markers forged by the document and fails without the real ones', () => {
    const forged = '%KAXOLAX-BODY-END-other\n\\end{document}\nEvil'
    const { latex } = splitLatex(pandocOutput('real', forged), 'real', 'fragment')
    expect(latex).toBe(`${forged}\n`)
    expect(() => splitLatex(pandocOutput('real', 'x'), 'other', 'fragment')).toThrow(ConvertError)
    // Un \begin{document} dans le corps (LaTeX brut) ne change pas le préambule.
    const raw = splitLatex(pandocOutput('m3', '\\begin{document}'), 'm3', 'fragment')
    expect(raw.preamble).toContain('\\usepackage{graphicx}')
  })
})

describe('dropUnusedCitationSetup', () => {
  const natbib = (body: string, extra = '') =>
    pandocOutput('c1', body).replace(
      '\\begin{document}',
      `\\usepackage[]{natbib}\n\\bibliographystyle{plainnat}\n${extra}\\begin{document}`,
    )

  it('drops natbib or biblatex loaded for a document without citations', () => {
    const plain = dropUnusedCitationSetup(natbib('Corps.'), 'c1', false)
    expect(plain).not.toMatch(/natbib|bibliographystyle/)
    expect(plain).toBe(pandocOutput('c1', 'Corps.'))
    const biblatex = pandocOutput('c2', 'Corps.')
      .replace('\\begin{document}', '\\usepackage[]{biblatex}\n\\begin{document}')
      .replace('\\end{document}', '\\printbibliography\n\\end{document}')
    expect(dropUnusedCitationSetup(biblatex, 'c2', false)).toBe(pandocOutput('c2', 'Corps.'))
  })

  it('keeps them with citations or a bibliography, and never touches the body', () => {
    expect(dropUnusedCitationSetup(natbib('\\citep{a}'), 'c1', true)).toBe(natbib('\\citep{a}'))
    const withBib = natbib('Corps.').replace(
      '\\end{document}',
      '\\bibliography{refs}\n\\end{document}',
    )
    expect(dropUnusedCitationSetup(withBib, 'c1', false)).toBe(withBib)
    const raw = natbib('\\printbibliography\n\\usepackage{natbib}')
    expect(dropUnusedCitationSetup(raw, 'c1', false)).toContain(
      '\\printbibliography\n\\usepackage{natbib}',
    )
  })
})

describe('sensitiveCommandsWarning', () => {
  const strict = resolveConvertOptions(request())
  it('flags commands copied from formulas or metadata when raw LaTeX is off', () => {
    expect(
      sensitiveCommandsWarning(
        'Texte \\(\\input{/etc/passwd}\\).\n\\begin{verbatim}\n\\catcode\n\\end{verbatim}\n',
        '\\(\\directlua{os.exit()}\\)\n',
        strict,
      ),
    ).toBe(
      'Formulas or metadata contain LaTeX commands copied as is: \\input, \\directlua ' +
        '(file and shell access stay blocked when compiling)',
    )
    expect(sensitiveCommandsWarning('\\section{A} \\(x^2\\)', null, strict)).toBeNull()
    // LaTeX brut demandé : rien à signaler, l'utilisateur l'a voulu.
    expect(
      sensitiveCommandsWarning(
        '\\input{x}',
        null,
        resolveConvertOptions(request({ options: { rawLatex: true } })),
      ),
    ).toBeNull()
  })
})

describe('pandoc output parsing', () => {
  it('collects warnings with their continuation lines', () => {
    expect(
      parsePandocWarnings(
        '[INFO] Running filter\n[WARNING] Could not fetch resource x.png\n  replacing image\n[WARNING] Duplicate note\n',
      ),
    ).toEqual(['Could not fetch resource x.png\nreplacing image', 'Duplicate note'])
  })

  it('maps sandbox outcomes to failure reasons', () => {
    const base: SandboxResult = {
      outcome: 'exited',
      exitCode: 0,
      oomKilled: false,
      killReason: null,
      durationMs: 1,
      output: '',
    }
    expect(convertFailure(base, 30_000)).toBeNull()
    expect(convertFailure({ ...base, outcome: 'timeout' }, 30_000)?.reason).toBe('timeout')
    expect(convertFailure({ ...base, outcome: 'killed' }, 30_000)?.reason).toBe('output_too_large')
    expect(
      convertFailure({ ...base, exitCode: 251, output: 'pandoc: Heap exhausted;' }, 30_000)?.reason,
    ).toBe('out_of_memory')
    const failed = convertFailure({ ...base, exitCode: 64, output: 'YAML parse exception' }, 1)
    expect(failed).toMatchObject({ reason: 'failed', message: 'YAML parse exception' })
  })

  it('validates the filter report as untrusted data', () => {
    expect(parseReport('{"title":null,"images":{}}').images).toEqual([])
    expect(parseReport('{"title":null,"images":[],"citations":{}}').citations).toEqual([])
    expect(
      parseReport('{"title":null,"images":[],"citations":["knuth84"],"rejectedCitations":["a%b"]}'),
    ).toMatchObject({ citations: ['knuth84'], rejectedCitations: ['a%b'] })
    expect(() =>
      parseReport(`{"title":null,"images":[],"citations":[${'"k",'.repeat(500)}"k"]}`),
    ).toThrow(ConvertError)
    expect(() => parseReport('{"title":1,"images":[]}')).toThrow(ConvertError)
    expect(() => parseReport('not json')).toThrow(ConvertError)
  })

  it('checks project images against the media list, extensions included', () => {
    const report = parseReport(
      JSON.stringify({
        title: null,
        images: [
          { source: 'a.png', kind: 'project', path: 'notes/a.png' },
          { source: 'plot', kind: 'project', path: 'notes/plot' },
          { source: 'b.png', kind: 'project', path: 'notes/b.png' },
          { source: 'x', kind: 'project', path: '../x' },
          { source: 'https://e.org/i.png', kind: 'remote' },
          { source: '/etc/passwd', kind: 'rejected', reason: 'absolute_path' },
        ],
      }),
    )
    const { images, warnings } = describeImages(report, ['notes/a.png', 'notes/plot.pdf'])
    expect(images.map((image) => [image.path, image.found])).toEqual([
      ['notes/a.png', true],
      ['notes/plot', true],
      ['notes/b.png', false],
      [null, false],
      [null, null],
      [null, null],
    ])
    expect(warnings).toEqual([
      'Image not found in the project: notes/b.png',
      'Image not found in the project: x',
      'Remote image replaced by a link: https://e.org/i.png',
      'Image ignored (absolute_path): /etc/passwd',
    ])
    expect(describeImages(report, undefined).images[0]?.found).toBeNull()
  })
})

describe('Compiler.convert', () => {
  it('runs pandoc in a fresh directory, returns LaTeX and extracted media, then cleans up', async () => {
    const sandbox = new FakeSandbox()
    const result = convertResultSchema.parse(await compiler(sandbox).convert(request()))
    const [run] = sandbox.runs
    expect(run?.command).toEqual(convertCommand(resolveConvertOptions(request())))
    expect(run?.timeoutMs).toBe(30_000)
    expect(run?.workingDir).toBe(run?.hostWorkdir)
    expect(run?.hostWorkdir.startsWith(join(dir, 'compiles', CONVERT_DIR))).toBe(true)
    expect(sandbox.seen).toMatchObject({
      [CONVERT_FILES.input]: request().markdown,
      [CONVERT_FILES.media]: 'directory',
    })
    expect(Object.keys(sandbox.seen).sort()).toEqual(
      [CONVERT_FILES.options, CONVERT_FILES.input, CONVERT_FILES.media].sort(),
    )
    expect(sandbox.filter?.marker).toMatch(/^[0-9a-f]{32}$/)

    expect(result.latex).toContain('\\documentclass[')
    expect(result.latex).toContain('\\includegraphics{../notes/img/plot.png}')
    expect(result.preamble).toBeNull()
    expect(result.title).toBe('Titre')
    expect(result.media).toEqual([
      {
        path: `chapters/media/${PNG_NAME}`,
        contentType: 'image/png',
        sizeBytes: PNG.byteLength,
        sha256: createHash('sha256').update(PNG).digest('hex'),
        contentBase64: PNG.toString('base64'),
      },
    ])
    expect(result.images).toEqual([
      {
        source: 'img/plot.png',
        kind: 'project',
        path: 'notes/img/plot.png',
        reason: null,
        found: true,
      },
    ])
    expect(result.warnings).toEqual([])
    // Répertoire temporaire supprimé ; aucun répertoire de projet créé.
    expect(await readdir(join(dir, 'compiles'))).toEqual([CONVERT_DIR])
    expect(await readdir(join(dir, 'compiles', CONVERT_DIR))).toEqual([])
  })

  it('returns a fragment with its preamble', async () => {
    const sandbox = new FakeSandbox()
    const result = await compiler(sandbox).convert(
      request({ options: { mode: 'fragment', documentClass: 'report' } }),
    )
    expect(sandbox.filter?.fragment).toBe(true)
    expect(result.latex.startsWith('\\section{Bonjour}')).toBe(true)
    expect(result.preamble).toContain('\\usepackage{graphicx}')
  })

  it('returns the cited keys and warns about the citations kept as text', async () => {
    const sandbox = new FakeSandbox()
    sandbox.body = 'Voir \\citep[p.~3]{knuth84}.'
    sandbox.report = {
      title: null,
      images: [],
      citations: ['knuth84'],
      rejectedCitations: ['a\\input{/etc/passwd}b'],
    }
    const result = await compiler(sandbox).convert(request())
    expect(result.citations).toEqual(['knuth84'])
    expect(result.warnings).toContain(
      'Citations kept as text (unsupported key): a\\input{/etc/passwd}b',
    )
  })

  it('maps a timeout, a pandoc error and missing outputs to conversion errors', async () => {
    const sandbox = new FakeSandbox()
    const instance = compiler(sandbox)
    sandbox.result = { outcome: 'timeout' }
    await expect(instance.convert(request({ timeoutMs: 5_000 }))).rejects.toMatchObject({
      reason: 'timeout',
      message: 'Conversion timed out after 5 s',
    })
    expect(sandbox.runs[0]?.timeoutMs).toBe(5_000)
    sandbox.result = { exitCode: 64, output: 'Error parsing YAML metadata' }
    await expect(instance.convert(request())).rejects.toMatchObject({ reason: 'failed' })
    sandbox.result = {}
    sandbox.tamper = (directory) => rm(join(directory, CONVERT_FILES.report))
    await expect(instance.convert(request())).rejects.toThrow('Conversion report is missing')
    expect(await readdir(join(dir, 'compiles', CONVERT_DIR))).toEqual([])
  })

  it('never follows a symbolic link planted in the outputs', async () => {
    const secret = join(dir, 'secret.txt')
    await writeFile(secret, 'KX-SECRET')
    const sandbox = new FakeSandbox()
    const instance = compiler(sandbox)

    sandbox.tamper = async (directory) => {
      await rm(join(directory, CONVERT_FILES.output))
      await symlink(secret, join(directory, CONVERT_FILES.output))
    }
    await expect(instance.convert(request())).rejects.toThrow('pandoc produced no output')

    sandbox.tamper = async (directory) => {
      await rm(join(directory, CONVERT_FILES.media), { recursive: true })
      await mkdir(join(dir, 'elsewhere'), { recursive: true })
      await writeFile(join(dir, 'elsewhere', PNG_NAME), 'KX-SECRET')
      await symlink(join(dir, 'elsewhere'), join(directory, CONVERT_FILES.media))
    }
    await expect(instance.convert(request())).rejects.toThrow('Media directory is invalid')

    sandbox.tamper = async (directory) => {
      const media = join(directory, CONVERT_FILES.media)
      await rm(join(media, PNG_NAME))
      await symlink(secret, join(media, PNG_NAME))
      await writeFile(join(media, 'notes.txt'), 'ignored')
    }
    const result = await instance.convert(request())
    expect(result.media).toEqual([])
    expect(JSON.stringify(result)).not.toContain('KX-SECRET')
  })

  it('refuses outputs beyond the limits', async () => {
    const sandbox = new FakeSandbox()
    const instance = compiler(sandbox)
    sandbox.tamper = async (directory) => {
      for (let index = 0; index <= MAX_CONVERT_EMBEDDED_IMAGES; index++) {
        const name = `${index.toString(16).padStart(40, '0')}.png`
        await writeFile(join(directory, CONVERT_FILES.media, name), PNG)
      }
    }
    await expect(instance.convert(request())).rejects.toMatchObject({
      reason: 'output_too_large',
    })
    sandbox.tamper = (directory) =>
      writeFile(join(directory, CONVERT_FILES.media, PNG_NAME), Buffer.alloc(5 * 1024 * 1024))
    await expect(instance.convert(request())).rejects.toMatchObject({
      reason: 'output_too_large',
    })
    sandbox.tamper = (directory) =>
      writeFile(join(directory, CONVERT_FILES.output), Buffer.alloc(9 * 1024 * 1024, 0x61))
    await expect(instance.convert(request())).rejects.toMatchObject({
      reason: 'output_too_large',
    })
  })

  it('shares the short-run queue with word counts and refuses beyond it', async () => {
    const sandbox = new FakeSandbox(true)
    const instance = compiler(sandbox)
    const slots = (instance as unknown as { slots: { acquire(): Promise<() => void> } }).slots
    const release = await slots.acquire()
    const waiting = Array.from({ length: WORD_COUNT_MAX_WAITING }, () =>
      instance.convert(request()),
    )
    await expect(instance.convert(request())).rejects.toThrow(ConvertBusyError)
    release()
    expect(await Promise.all(waiting)).toHaveLength(WORD_COUNT_MAX_WAITING)
  })
})

describe('agent HTTP convert route', () => {
  const token = 'x'.repeat(40)
  const headers = { [INTERNAL_TOKEN_HEADER]: token }
  const logger = pino({ level: 'silent' })
  const url = `/projects/${projectId}/convert`

  it('validates the request, answers the result and maps failures to 422', async () => {
    const sandbox = new FakeSandbox()
    const app = buildServer({ compiler: compiler(sandbox), internalToken: token, logger })
    const ok = await app.inject({ method: 'POST', url, headers, payload: request() })
    expect(ok.statusCode).toBe(200)
    expect(convertResultSchema.parse(ok.json()).title).toBe('Titre')

    const unauthorized = await app.inject({ method: 'POST', url, payload: request() })
    expect(unauthorized.statusCode).toBe(401)

    const mismatch = await app.inject({
      method: 'POST',
      url: '/projects/0b8f7e6d-5c4b-4a39-8281-7f6e5d4c3b2a/convert',
      headers,
      payload: request(),
    })
    expect(mismatch.statusCode).toBe(400)

    for (const invalid of [
      request({ sourcePath: '../x.md' }),
      request({ targetPath: 'out.md' }),
      request({ mediaDir: '/tmp' }),
      { ...request(), options: { filters: ['evil.lua'] } },
      request({ markdown: 'x'.repeat(2 * 1024 * 1024 + 1) }),
    ]) {
      const response = await app.inject({ method: 'POST', url, headers, payload: invalid })
      expect(response.statusCode).toBe(400)
    }

    sandbox.result = { outcome: 'timeout' }
    const failed = await app.inject({ method: 'POST', url, headers, payload: request() })
    expect(failed.statusCode).toBe(422)
    expect(failed.json()).toEqual({
      error: 'convert_failed',
      reason: 'timeout',
      message: 'Conversion timed out after 30 s',
    })
    expect(sandbox.runs).toHaveLength(2)
  })

  it('answers 503 when the queue is full', async () => {
    const sandbox = new FakeSandbox(true)
    const instance = compiler(sandbox)
    const slots = (instance as unknown as { slots: { acquire(): Promise<() => void> } }).slots
    const release = await slots.acquire()
    const waiting = Array.from({ length: WORD_COUNT_MAX_WAITING }, () =>
      instance.convert(request()),
    )
    const app = buildServer({ compiler: instance, internalToken: token, logger })
    const busy = await app.inject({ method: 'POST', url, headers, payload: request() })
    expect(busy.statusCode).toBe(503)
    expect(busy.json()).toMatchObject({ error: 'convert_busy' })
    release()
    await Promise.all(waiting)
  })
})
