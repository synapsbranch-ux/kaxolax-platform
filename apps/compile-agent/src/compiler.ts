import { readFile, rm, stat } from 'node:fs/promises'
import { join, posix } from 'node:path'
import {
  type AgentCompileResponse,
  type AgentHealth,
  type CompileRequest,
  type CompileStatus,
  type Compiler as CompilerName,
  type LogEntry,
  type OutputFile,
  type SynctexCodeQuery,
  type SynctexCodeResponse,
  type SynctexPdfQuery,
  type SynctexPdfResponse,
} from '@kaxolax/contracts'
import { parseCompileLogs } from '@kaxolax/latex-log-parser'
import { OUTPUT_LIMITS } from './config.js'
import { type Sandbox, SANDBOX_WORKDIR, type SandboxResult } from './sandbox.js'
import { Semaphore } from './semaphore.js'
import { ChecksumMismatchError, type OutputStore } from './storage.js'
import { parseSynctexEdit, parseSynctexView, relativeToRoot, rootDirectory } from './synctex.js'
import {
  type BinarySource,
  directorySize,
  projectPaths,
  readRootResourcePath,
  touchProject,
  UnsafePathError,
  syncWorkspace,
} from './workspace.js'

const ENGINE_FLAGS: Record<CompilerName, string> = {
  pdflatex: '-pdf',
  xelatex: '-xelatex',
  lualatex: '-lualatex',
}

/** Sorties envoyées vers S3 (le fichier SyncTeX reste sur l'agent, qui répond aux requêtes). */
const UPLOADED_OUTPUTS: { name: string; contentType: string }[] = [
  { name: 'output.pdf', contentType: 'application/pdf' },
  { name: 'output.log', contentType: 'text/plain; charset=utf-8' },
  { name: 'output.blg', contentType: 'text/plain; charset=utf-8' },
]

const SYNCTEX_TIMEOUT_MS = 20_000

/**
 * Commande de compilation. `-norc` n'est pas dans la spécification : sans lui, latexmk exécuterait
 * le `latexmkrc` (du Perl) d'un projet (voir docs/decisions.md).
 */
export function latexmkCommand(compiler: CompilerName, mainFile: string): string[] {
  return [
    'latexmk',
    '-norc',
    '-cd',
    '-f',
    '-jobname=output',
    '-synctex=1',
    '-interaction=batchmode',
    '-file-line-error',
    ENGINE_FLAGS[compiler],
    mainFile,
  ]
}

export interface CompilerLogger {
  info(data: object, message: string): void
  warn(data: object, message: string): void
}

export interface CompilerOptions {
  agentId: string
  compilesDir: string
  capacity: number
  workdirMaxBytes: number
  outputBucket: string
  sandbox: Sandbox
  binaries: BinarySource
  outputs: OutputStore
  logger: CompilerLogger
}

export class InvalidRequestError extends Error {}

interface Running {
  controller: AbortController
  done: Promise<unknown>
}

function agentEntry(message: string): LogEntry {
  return { level: 'error', file: null, line: null, message, raw: '' }
}

async function fileSize(path: string): Promise<number | null> {
  try {
    const info = await stat(path)
    return info.isFile() ? info.size : null
  } catch {
    return null
  }
}

/** Ramène un chemin du log (relatif au répertoire du document principal) à un chemin du projet. */
function projectFile(file: string | null, rootDir: string): string | null {
  if (file === null || file.startsWith('/')) return file
  const joined = posix.normalize(posix.join(rootDir, file))
  return joined.startsWith('../') ? null : joined
}

export class Compiler {
  private readonly slots: Semaphore
  private readonly running = new Map<string, Running>()
  /** Garantit qu'un seul traitement touche le répertoire d'un projet à la fois. */
  private readonly projectQueues = new Map<string, Promise<unknown>>()

  constructor(private readonly options: CompilerOptions) {
    this.slots = new Semaphore(options.capacity)
  }

  health(): AgentHealth {
    return {
      agentId: this.options.agentId,
      activeCompiles: this.slots.active + this.slots.waiting,
      capacity: this.options.capacity,
    }
  }

  isCompiling(projectId: string): boolean {
    return this.running.has(projectId)
  }

  private exclusive<T>(projectId: string, task: () => Promise<T>): Promise<T> {
    const previous = this.projectQueues.get(projectId) ?? Promise.resolve()
    const next = previous.catch(() => undefined).then(task)
    this.projectQueues.set(projectId, next)
    void next
      .finally(() => {
        if (this.projectQueues.get(projectId) === next) this.projectQueues.delete(projectId)
      })
      .catch(() => undefined)
    return next
  }

  /** Arrête la compilation en cours d'un projet et attend qu'elle soit terminée. */
  async stop(projectId: string): Promise<boolean> {
    const current = this.running.get(projectId)
    if (!current) return false
    current.controller.abort()
    await current.done.catch(() => undefined)
    return true
  }

  async compile(request: CompileRequest): Promise<AgentCompileResponse> {
    if (request.output.bucket !== this.options.outputBucket) {
      throw new InvalidRequestError(`Unexpected output bucket: ${request.output.bucket}`)
    }
    // Une nouvelle demande sur un projet en cours de compilation arrête la précédente.
    await this.stop(request.projectId)
    const controller = new AbortController()
    const done = this.exclusive(request.projectId, async () => {
      const release = await this.slots.acquire()
      try {
        return await this.run(request, controller.signal)
      } finally {
        release()
      }
    })
    const entry: Running = { controller, done }
    this.running.set(request.projectId, entry)
    try {
      return await done
    } finally {
      if (this.running.get(request.projectId) === entry) this.running.delete(request.projectId)
    }
  }

  private async run(request: CompileRequest, signal: AbortSignal): Promise<AgentCompileResponse> {
    const started = performance.now()
    const paths = projectPaths(this.options.compilesDir, request.projectId)
    const rootDir = rootDirectory(request.rootResourcePath)
    const mainFile = posix.basename(request.rootResourcePath)
    const outputDir = rootDir === '' ? paths.files : join(paths.files, rootDir)
    const timings = { syncMs: 0, runMs: 0, uploadMs: 0 }
    const finish = (status: CompileStatus, entries: LogEntry[], outputFiles: OutputFile[] = []) => {
      const response: AgentCompileResponse = {
        buildId: request.buildId,
        status,
        durationMs: Math.round(performance.now() - started),
        outputFiles,
        entries,
        timings,
      }
      this.options.logger.info(
        {
          projectId: request.projectId,
          buildId: request.buildId,
          compiler: request.compiler,
          status,
          durationMs: response.durationMs,
          ...timings,
        },
        'compile finished',
      )
      return response
    }

    if (signal.aborted) return finish('error', [agentEntry('Compilation stopped')])

    // 1. Synchronisation par hash.
    const syncStarted = performance.now()
    try {
      const stats = await syncWorkspace(
        paths,
        request.resources,
        this.options.binaries,
        request.rootResourcePath,
      )
      timings.syncMs = Math.round(performance.now() - syncStarted)
      this.options.logger.info(
        { projectId: request.projectId, ...stats, syncMs: timings.syncMs },
        'workspace synced',
      )
    } catch (error) {
      timings.syncMs = Math.round(performance.now() - syncStarted)
      if (error instanceof UnsafePathError || error instanceof ChecksumMismatchError) {
        return finish('error', [agentEntry(error.message)])
      }
      this.options.logger.warn(
        { projectId: request.projectId, err: error },
        'workspace sync failed',
      )
      return finish('error', [agentEntry('Could not prepare the project files for compilation')])
    }
    if ((await directorySize(paths.files)) > this.options.workdirMaxBytes) {
      return finish('error', [agentEntry('Project files exceed the working directory size limit')])
    }

    // 2. Compilation dans un conteneur neuf.
    const runStarted = performance.now()
    let result: SandboxResult
    try {
      result = await this.options.sandbox.run({
        command: latexmkCommand(request.compiler, mainFile),
        hostWorkdir: paths.files,
        workingDir: rootDir === '' ? SANDBOX_WORKDIR : `${SANDBOX_WORKDIR}/${rootDir}`,
        timeoutMs: request.timeoutMs,
        signal,
        labels: { 'dev.kaxolax.project': request.projectId, 'dev.kaxolax.build': request.buildId },
        watchdog: {
          intervalMs: 1_000,
          check: async () =>
            (await directorySize(paths.files)) > this.options.workdirMaxBytes
              ? 'working directory size limit exceeded'
              : null,
        },
      })
    } finally {
      timings.runMs = Math.round(performance.now() - runStarted)
    }

    // 3. Statut, plafonds de sortie et log parsé.
    const entries: LogEntry[] = []
    let status: CompileStatus
    if (result.outcome === 'timeout') {
      status = 'timeout'
      entries.push(
        agentEntry(`Compilation timed out after ${String(Math.round(request.timeoutMs / 1000))} s`),
      )
    } else if (result.outcome === 'stopped') {
      status = 'error'
      entries.push(agentEntry('Compilation stopped'))
    } else if (result.outcome === 'killed') {
      status = 'error'
      entries.push(agentEntry(`Compilation killed: ${result.killReason ?? 'unknown reason'}`))
    } else if (result.oomKilled) {
      status = 'error'
      entries.push(agentEntry('Compilation ran out of memory'))
    } else {
      status = result.exitCode === 0 ? 'success' : 'failure'
    }

    const pdfPath = join(outputDir, 'output.pdf')
    const logPath = join(outputDir, 'output.log')
    const blgPath = join(outputDir, 'output.blg')
    const pdfSize = await fileSize(pdfPath)
    const logSize = await fileSize(logPath)
    let uploadPdf = pdfSize !== null
    if (pdfSize !== null && pdfSize > OUTPUT_LIMITS.pdfBytes) {
      status = 'error'
      uploadPdf = false
      entries.push(agentEntry('Output PDF exceeds the 100 MB limit'))
    }
    let uploadLog = logSize !== null
    if (logSize !== null && logSize > OUTPUT_LIMITS.logBytes) {
      status = 'error'
      uploadLog = false
      entries.push(agentEntry('Log file exceeds the 10 MB limit'))
    }
    if (status === 'success' && pdfSize === null) status = 'failure'

    if (uploadLog) {
      const blg = await readFile(blgPath).catch(() => null)
      const parsed = parseCompileLogs(
        { log: await readFile(logPath), blg },
        { rootDir: rootDir === '' ? SANDBOX_WORKDIR : `${SANDBOX_WORKDIR}/${rootDir}` },
      )
      entries.unshift(
        ...parsed.map((entry) => ({ ...entry, file: projectFile(entry.file, rootDir) })),
      )
    }

    // 4. Envoi des sorties vers S3.
    const uploadStarted = performance.now()
    const outputFiles: OutputFile[] = []
    for (const output of UPLOADED_OUTPUTS) {
      if (output.name === 'output.pdf' && !uploadPdf) continue
      if (output.name === 'output.log' && !uploadLog) continue
      const path = join(outputDir, output.name)
      const size = await fileSize(path)
      if (size === null || size > OUTPUT_LIMITS.pdfBytes) continue
      const key = `${request.output.prefix}${output.name}`
      await this.options.outputs.put(request.output.bucket, key, path, output.contentType)
      outputFiles.push({ name: output.name, s3Key: key, sizeBytes: size })
    }
    timings.uploadMs = Math.round(performance.now() - uploadStarted)
    return finish(status, entries, outputFiles)
  }

  async clearCache(projectId: string): Promise<boolean> {
    await this.stop(projectId)
    return this.exclusive(projectId, async () => {
      await rm(projectPaths(this.options.compilesDir, projectId).root, {
        recursive: true,
        force: true,
      })
      return true
    })
  }

  private async synctex(
    projectId: string,
    args: (rootDir: string) => string[],
  ): Promise<{
    output: string
    rootDir: string
  } | null> {
    const paths = projectPaths(this.options.compilesDir, projectId)
    const rootResourcePath = await readRootResourcePath(paths)
    if (rootResourcePath === null) return null
    const rootDir = rootDirectory(rootResourcePath)
    const synctexFile = join(
      rootDir === '' ? paths.files : join(paths.files, rootDir),
      'output.synctex.gz',
    )
    if ((await fileSize(synctexFile)) === null) return null
    await touchProject(paths)
    const result = await this.options.sandbox.run({
      command: ['synctex', ...args(rootDir)],
      hostWorkdir: paths.files,
      workingDir: rootDir === '' ? SANDBOX_WORKDIR : `${SANDBOX_WORKDIR}/${rootDir}`,
      readOnly: true,
      timeoutMs: SYNCTEX_TIMEOUT_MS,
      labels: { 'dev.kaxolax.project': projectId, 'dev.kaxolax.synctex': 'true' },
    })
    return result.outcome === 'exited' ? { output: result.output, rootDir } : null
  }

  /** Du code vers le PDF, avec le binaire synctex dans le même sandbox que la compilation. */
  async synctexFromCode(projectId: string, query: SynctexCodeQuery): Promise<SynctexCodeResponse> {
    const result = await this.exclusive(projectId, () =>
      this.synctex(projectId, (rootDir) => [
        'view',
        '-i',
        `${String(query.line)}:${String(query.column)}:${relativeToRoot(query.file, rootDir)}`,
        '-o',
        'output.pdf',
      ]),
    )
    return { pdf: result === null ? [] : parseSynctexView(result.output) }
  }

  /** Du PDF vers le code. */
  async synctexFromPdf(projectId: string, query: SynctexPdfQuery): Promise<SynctexPdfResponse> {
    const result = await this.exclusive(projectId, () =>
      this.synctex(projectId, () => [
        'edit',
        '-o',
        `${String(query.page)}:${String(query.h)}:${String(query.v)}:output.pdf`,
      ]),
    )
    return { code: result === null ? [] : parseSynctexEdit(result.output, result.rootDir) }
  }
}
