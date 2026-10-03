import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import {
  type CompileRequest,
  type CompileResource,
  compileOutputPrefix,
  type Compiler as CompilerName,
  isTextDocument,
  projectFilesPrefix,
} from '@kaxolax/contracts'
import { pino } from 'pino'
import { Compiler } from '../../src/compiler.js'
import { DockerClient } from '../../src/docker.js'
import { Sandbox } from '../../src/sandbox.js'
import { BinaryCache, LocalOutputStore } from '../../src/storage.js'
import { sha256Hex } from '../../src/workspace.js'

export const IMAGE = process.env.KAXOLAX_TEST_IMAGE ?? 'kaxolax-texlive:2026-medium'
export const RUNTIME = process.env.COMPILE_RUNTIME === 'runsc' ? 'runsc' : 'runc'
export const BUCKET = 'test-outputs'

/** Docker et l'image sont-ils disponibles ? En CI, leur absence doit faire échouer les tests. */
export async function dockerAvailable(): Promise<boolean> {
  const docker = new DockerClient(process.env.DOCKER_SOCKET ?? '/var/run/docker.sock')
  try {
    await docker.ping()
    const present = await docker.imageExists(IMAGE)
    if (!present && process.env.KAXOLAX_REQUIRE_INTEGRATION === '1') {
      throw new Error(`Test image ${IMAGE} is missing`)
    }
    return present
  } catch (error) {
    if (process.env.KAXOLAX_REQUIRE_INTEGRATION === '1') throw error
    return false
  }
}

/**
 * L'image a-t-elle pandoc (conversion Markdown → LaTeX) ? Les images publiées avant son ajout ne
 * l'ont pas : les tests de conversion sont alors ignorés, sauf avec `KAXOLAX_REQUIRE_PANDOC=1`.
 */
export function pandocAvailable(): boolean {
  try {
    execFileSync('docker', ['run', '--rm', '--network', 'none', IMAGE, 'pandoc', '--version'], {
      stdio: 'ignore',
    })
    return true
  } catch (error) {
    if (process.env.KAXOLAX_REQUIRE_PANDOC === '1') throw error
    return false
  }
}

export interface TestAgent {
  compiler: Compiler
  root: string
  compilesDir: string
  outputsDir: string
  files: Map<string, string>
  cleanup(): Promise<void>
}

export async function createTestAgent(capacity = 2): Promise<TestAgent> {
  const root = await mkdtemp(join(tmpdir(), 'kaxolax-agent-it-'))
  const compilesDir = join(root, 'compiles')
  const outputsDir = join(root, 'outputs')
  const files = new Map<string, string>()
  const cache = new BinaryCache(join(root, 'cache'), (s3Key) => {
    const path = files.get(s3Key)
    if (path === undefined) throw new Error(`unknown binary ${s3Key}`)
    return Promise.resolve(createReadStream(path))
  })
  const compiler = new Compiler({
    agentId: 'test',
    compilesDir,
    capacity,
    workdirMaxBytes: 2 * 1024 * 1024 * 1024,
    outputBucket: BUCKET,
    sandbox: new Sandbox(new DockerClient(process.env.DOCKER_SOCKET ?? '/var/run/docker.sock'), {
      image: IMAGE,
      runtime: RUNTIME,
    }),
    binaries: cache,
    outputs: new LocalOutputStore(outputsDir),
    logger: pino({ level: process.env.LOG_LEVEL ?? 'silent' }),
  })
  return {
    compiler,
    root,
    compilesDir,
    outputsDir,
    files,
    cleanup: () => rm(root, { recursive: true, force: true }),
  }
}

async function listFiles(directory: string, base = directory): Promise<string[]> {
  const result: string[] = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) result.push(...(await listFiles(path, base)))
    else if (entry.isFile()) result.push(relative(base, path))
  }
  return result.sort()
}

/** Ressources d'un dossier local ; les binaires sont servis depuis le disque. */
export async function resourcesFromDirectory(
  agent: TestAgent,
  projectId: string,
  directory: string,
  transform: (path: string, content: string) => string = (_path, content) => content,
): Promise<CompileResource[]> {
  const resources: CompileResource[] = []
  for (const path of await listFiles(directory)) {
    if (path === 'case.json') continue
    const bytes = await readFile(join(directory, path))
    if (isTextDocument(path, bytes)) {
      const content = transform(path, new TextDecoder().decode(bytes))
      resources.push({ path, kind: 'text', content, sha256: sha256Hex(content) })
    } else {
      const s3Key = `${projectFilesPrefix(projectId)}${path}`
      agent.files.set(s3Key, join(directory, path))
      resources.push({ path, kind: 'binary', s3Key, sha256: sha256Hex(bytes) })
    }
  }
  return resources
}

export function textResources(files: Record<string, string>): CompileResource[] {
  return Object.entries(files).map(([path, content]) => ({
    path,
    kind: 'text',
    content,
    sha256: sha256Hex(content),
  }))
}

export function compileRequest(
  projectId: string,
  resources: CompileResource[],
  options: { compiler?: CompilerName; timeoutMs?: number; root?: string } = {},
): CompileRequest {
  const buildId = randomUUID()
  return {
    projectId,
    buildId,
    compiler: options.compiler ?? 'pdflatex',
    rootResourcePath: options.root ?? 'main.tex',
    timeoutMs: options.timeoutMs ?? 60_000,
    resources,
    output: { bucket: BUCKET, prefix: compileOutputPrefix(projectId, buildId) },
  }
}

/** Copie les cas malveillants embarqués dans l'image TeX Live. */
export function extractMaliciousCases(target: string): string {
  const id = execFileSync('docker', ['create', IMAGE], { encoding: 'utf8' }).trim()
  try {
    execFileSync('docker', ['cp', `${id}:/usr/share/kaxolax/malicious`, target])
  } finally {
    execFileSync('docker', ['rm', id])
  }
  return join(target, 'malicious')
}
