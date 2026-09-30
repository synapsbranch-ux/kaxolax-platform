import { randomUUID } from 'node:crypto'
import { mkdtemp, readdir, readFile, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  compileRequest,
  createTestAgent,
  dockerAvailable,
  resourcesFromDirectory,
  RUNTIME,
  type TestAgent,
  textResources,
} from './helpers.js'

const available = await dockerAvailable()
const demoDir = join(import.meta.dirname, '../../examples/demo')

describe.skipIf(!available)(`compile agent with real Docker (${RUNTIME})`, () => {
  let agent: TestAgent

  beforeAll(async () => {
    agent = await createTestAgent()
  })

  afterAll(async () => {
    await agent.cleanup()
  })

  it('compiles the demo project, uploads the PDF, and recompiles faster when nothing changed', async () => {
    const projectId = randomUUID()
    const resources = await resourcesFromDirectory(agent, projectId, demoDir)
    const cold = await agent.compiler.compile(compileRequest(projectId, resources))
    expect(cold.status).toBe('success')
    expect(cold.entries.filter((entry) => entry.level === 'error')).toEqual([])
    expect(cold.outputFiles.map((file) => file.name)).toEqual([
      'output.pdf',
      'output.log',
      'output.blg',
    ])
    const pdf = cold.outputFiles[0]
    const pdfBytes = await readFile(join(agent.outputsDir, 'test-outputs', pdf?.s3Key ?? ''))
    expect(pdfBytes.subarray(0, 5).toString()).toBe('%PDF-')

    const hot = await agent.compiler.compile(compileRequest(projectId, resources))
    expect(hot.status).toBe('success')
    console.log(
      `demo project: cold ${String(cold.durationMs)} ms, hot ${String(hot.durationMs)} ms`,
    )
    expect(hot.timings.syncMs).toBeLessThanOrEqual(cold.timings.syncMs + 50)
    expect(hot.durationMs).toBeLessThan(cold.durationMs * 0.7)
  })

  it('reports an error with its file and line', async () => {
    const projectId = randomUUID()
    const result = await agent.compiler.compile(
      compileRequest(
        projectId,
        textResources({
          'main.tex':
            '\\documentclass{article}\n\\begin{document}\n\\input{chapters/intro}\n\\end{document}\n',
          'chapters/intro.tex': 'First line.\nSecond line with \\undefinedcommand here.\n',
        }),
      ),
    )
    expect(result.status).toBe('failure')
    expect(result.entries).toContainEqual(
      expect.objectContaining({
        level: 'error',
        file: 'chapters/intro.tex',
        line: 2,
        message: 'Undefined control sequence.',
      }),
    )
  })

  it('compiles a main document in a subdirectory and maps log paths to the project', async () => {
    const projectId = randomUUID()
    const result = await agent.compiler.compile(
      compileRequest(
        projectId,
        textResources({
          'thesis/main.tex':
            '\\documentclass{article}\n\\begin{document}\n\\input{part}\n\\end{document}\n',
          'thesis/part.tex': 'Oops \\missingmacro.\n',
        }),
        { root: 'thesis/main.tex' },
      ),
    )
    expect(result.entries).toContainEqual(
      expect.objectContaining({ level: 'error', file: 'thesis/part.tex', line: 1 }),
    )
    expect(result.outputFiles.map((file) => file.name)).toContain('output.pdf')
  })

  it('kills an infinite loop at the timeout', async () => {
    const projectId = randomUUID()
    const started = Date.now()
    const result = await agent.compiler.compile(
      compileRequest(
        projectId,
        textResources({
          'main.tex': '\\documentclass{article}\\begin{document}\\def\\x{\\x}\\x\\end{document}',
        }),
        { timeoutMs: 5_000 },
      ),
    )
    expect(result.status).toBe('timeout')
    expect(Date.now() - started).toBeLessThan(30_000)
  })

  it('stops a running compilation on request', async () => {
    const projectId = randomUUID()
    const running = agent.compiler.compile(
      compileRequest(
        projectId,
        textResources({
          'main.tex': '\\documentclass{article}\\begin{document}\\def\\x{\\x}\\x\\end{document}',
        }),
      ),
    )
    await new Promise((resolve) => setTimeout(resolve, 2_000))
    const started = Date.now()
    expect(await agent.compiler.stop(projectId)).toBe(true)
    const result = await running
    expect(result.status).toBe('error')
    expect(result.entries).toContainEqual(
      expect.objectContaining({ message: 'Compilation stopped' }),
    )
    expect(Date.now() - started).toBeLessThan(15_000)
  })

  it('a new request on a compiling project stops the previous one', async () => {
    const projectId = randomUUID()
    const loop = textResources({
      'main.tex': '\\documentclass{article}\\begin{document}\\def\\x{\\x}\\x\\end{document}',
    })
    const first = agent.compiler.compile(compileRequest(projectId, loop))
    await new Promise((resolve) => setTimeout(resolve, 1_500))
    const second = await agent.compiler.compile(
      compileRequest(
        projectId,
        textResources({ 'main.tex': '\\documentclass{article}\\begin{document}ok\\end{document}' }),
      ),
    )
    expect((await first).status).toBe('error')
    expect(second.status).toBe('success')
  })

  it('goes from code to PDF and back with SyncTeX', async () => {
    const projectId = randomUUID()
    const resources = await resourcesFromDirectory(agent, projectId, demoDir)
    expect((await agent.compiler.compile(compileRequest(projectId, resources))).status).toBe(
      'success',
    )

    const forward = await agent.compiler.synctexFromCode(projectId, {
      file: 'chapters/intro.tex',
      line: 4,
      column: 0,
    })
    expect(forward.pdf.length).toBeGreaterThan(0)
    const position = forward.pdf[0]
    expect(position?.page).toBe(1)

    const backward = await agent.compiler.synctexFromPdf(projectId, {
      page: position?.page ?? 1,
      h: (position?.h ?? 0) + 5,
      v: (position?.v ?? 0) - 2,
    })
    expect(backward.code).toContainEqual(
      expect.objectContaining({ file: 'chapters/intro.tex', line: 4 }),
    )
  })

  it('refuses to write through a symbolic link planted in the working directory', async () => {
    const projectId = randomUUID()
    const outside = await mkdtemp(join(tmpdir(), 'kaxolax-outside-'))
    try {
      const base = textResources({
        'main.tex': '\\documentclass{article}\\begin{document}x\\end{document}',
      })
      expect((await agent.compiler.compile(compileRequest(projectId, base))).status).toBe('success')
      await symlink(outside, join(agent.compilesDir, projectId, 'files', 'chapters'))
      const result = await agent.compiler.compile(
        compileRequest(projectId, [...base, ...textResources({ 'chapters/pwned.tex': 'escaped' })]),
      )
      expect(result.status).toBe('error')
      expect(result.entries[0]?.message).toContain('symbolic link')
      expect(await readdir(outside)).toEqual([])
    } finally {
      await rm(outside, { recursive: true, force: true })
    }
  })

  it('never exposes the agent environment to the document', async () => {
    const secret = `kaxolax-secret-${randomUUID()}`
    process.env.KAXOLAX_TEST_SECRET = secret
    try {
      const projectId = randomUUID()
      const result = await agent.compiler.compile(
        compileRequest(
          projectId,
          textResources({
            'main.tex': [
              '\\documentclass{article}',
              '\\begin{document}',
              '\\directlua{local f = io.open("/proc/self/environ", "r")',
              // Pas de « % » : TeX le lirait comme un commentaire.
              '  if f then texio.write_nl("KX-ENV " .. f:read("a"):gsub(string.char(0), " ")) f:close() end}',
              'x',
              '\\end{document}',
            ].join('\n'),
          }),
          { compiler: 'lualatex' },
        ),
      )
      const log = await readFile(join(agent.compilesDir, projectId, 'files', 'output.log'), 'utf8')
      expect(log).toContain('KX-ENV')
      expect(log).not.toContain(secret)
      expect(JSON.stringify(result)).not.toContain(secret)
    } finally {
      delete process.env.KAXOLAX_TEST_SECRET
    }
  })
})
