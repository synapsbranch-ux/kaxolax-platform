import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { compileOutputPrefix, type CompileRequest } from '@kaxolax/contracts'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Compiler } from '../../src/compiler.js'
import { readRegularFile, regularFileSize } from '../../src/regular-file.js'
import { type CompileSandbox, type SandboxRunRequest } from '../../src/sandbox.js'
import { LocalOutputStore } from '../../src/storage.js'

const projectId = '6f1c2d3e-4b5a-4c7d-8e9f-0a1b2c3d4e5f'
const buildId = '0b8f7e6d-5c4b-4a39-8281-7f6e5d4c3b2a'
const BUCKET = 'kaxolax-compile-outputs'
const SECRET = 'INTERNAL_TOKEN=root-only-secret'

let dir: string
let secretPath: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'kaxolax-outputs-'))
  // Fichier réservé à root dans la VM (comme /proc/1/environ).
  secretPath = join(dir, 'environ')
  await writeFile(secretPath, SECRET, { mode: 0o600 })
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

/** Sandbox simulé : la « compilation » écrit ses sorties avec `write`, dans le répertoire du document. */
function fakeSandbox(write: (outputDir: string) => Promise<void>): CompileSandbox {
  return {
    workdirPath: (hostWorkdir: string) => hostWorkdir,
    async run(run: SandboxRunRequest) {
      await write(run.workingDir ?? run.hostWorkdir)
      return {
        outcome: 'exited',
        exitCode: 0,
        oomKilled: false,
        killReason: null,
        durationMs: 1,
        output: '',
      }
    },
  }
}

function request(root = 'main.tex'): CompileRequest {
  return {
    projectId,
    buildId,
    compiler: 'pdflatex',
    rootResourcePath: root,
    timeoutMs: 10_000,
    resources: [{ path: root, kind: 'text', content: 'x', sha256: 'a'.repeat(64) }],
    output: { bucket: BUCKET, prefix: compileOutputPrefix(projectId, buildId) },
  }
}

function compiler(sandbox: CompileSandbox, outputsDir: string) {
  return new Compiler({
    agentId: 'test',
    compilesDir: join(dir, 'compiles'),
    capacity: 1,
    workdirMaxBytes: 10 * 1024 * 1024,
    outputBucket: BUCKET,
    sandbox,
    binaries: { get: () => Promise.reject(new Error('no binaries')) },
    outputs: new LocalOutputStore(outputsDir),
    logger: { info: () => undefined, warn: () => undefined },
  })
}

/** Contenu de tous les fichiers copiés vers le stockage des sorties. */
async function storedContents(root: string): Promise<string[]> {
  const files = await readdir(root, { recursive: true, withFileTypes: true }).catch(() => [])
  return Promise.all(
    files
      .filter((entry) => entry.isFile())
      .map((entry) => readFile(join(entry.parentPath, entry.name), 'utf8')),
  )
}

describe('regular files', () => {
  it('reads regular files and refuses symbolic links', async () => {
    const link = join(dir, 'link')
    await symlink(secretPath, link)
    expect(await regularFileSize(secretPath)).toBe(SECRET.length)
    expect((await readRegularFile(secretPath))?.toString()).toBe(SECRET)
    expect(await regularFileSize(link)).toBeNull()
    expect(await readRegularFile(link)).toBeNull()
    expect(await regularFileSize(dir)).toBeNull()
    expect(await regularFileSize(join(dir, 'missing'))).toBeNull()
  })

  it('does not copy a symbolic link to the output store', async () => {
    const link = join(dir, 'output.pdf')
    await symlink(secretPath, link)
    const store = new LocalOutputStore(join(dir, 'store'))
    await expect(store.put(BUCKET, 'outputs/x/output.pdf', link)).rejects.toThrow()
    expect(await storedContents(join(dir, 'store'))).toEqual([])
  })

  it('never publishes outputs replaced by symbolic links', async () => {
    const outputsDir = join(dir, 'store')
    const sandbox = fakeSandbox(async (outputDir) => {
      await writeFile(join(outputDir, 'output.log'), 'Output written on output.pdf (1 page).\n')
      await symlink(secretPath, join(outputDir, 'output.pdf'))
      await symlink(secretPath, join(outputDir, 'output.synctex.gz'))
      await symlink(secretPath, join(outputDir, 'output.blg'))
    })
    const response = await compiler(sandbox, outputsDir).compile(request())
    expect(response.outputFiles.map((file) => file.name)).toEqual(['output.log'])
    expect(response.status).toBe('failure')
    expect(await storedContents(outputsDir)).not.toContain(SECRET)

    // Log remplacé par un lien : ni lu, ni publié.
    const logLink = fakeSandbox(async (outputDir) => {
      await rm(join(outputDir, 'output.log'), { force: true })
      await symlink(secretPath, join(outputDir, 'output.log'))
    })
    const second = await compiler(logLink, join(dir, 'store2')).compile(request())
    expect(second.outputFiles).toEqual([])
    expect(JSON.stringify(second.entries)).not.toContain(SECRET)
    expect(await storedContents(join(dir, 'store2'))).toEqual([])
  })

  it('reads no output from a document directory replaced by a symbolic link', async () => {
    const elsewhere = join(dir, 'elsewhere')
    await mkdir(elsewhere)
    await writeFile(join(elsewhere, 'output.log'), SECRET)
    const sandbox = fakeSandbox(async (outputDir) => {
      await rm(outputDir, { recursive: true, force: true })
      await symlink(elsewhere, outputDir)
    })
    const response = await compiler(sandbox, join(dir, 'store')).compile(request('thesis/main.tex'))
    expect(response.outputFiles).toEqual([])
    expect(await storedContents(join(dir, 'store'))).toEqual([])
  })
})
