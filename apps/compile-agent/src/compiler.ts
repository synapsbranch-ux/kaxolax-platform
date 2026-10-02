import { rm } from 'node:fs/promises'
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
import { type CompileSandbox, type SandboxResult } from './sandbox.js'
import { readRegularFile, regularFileSize } from './regular-file.js'
import { Semaphore } from './semaphore.js'
import { ChecksumMismatchError, type OutputStore } from './storage.js'
import { parseSynctexEdit, parseSynctexView, relativeToRoot, rootDirectory } from './synctex.js'
import {
  assertSafeTarget,
  type BinarySource,
  directorySize,
  projectPaths,
  readRootResourcePath,
  restoreSynctex,
  touchProject,
  UnsafePathError,
  syncWorkspace,
} from './workspace.js'

const ENGINE_FLAGS: Record<CompilerName, string> = {
  pdflatex: '-pdf',
  xelatex: '-xelatex',
  lualatex: '-lualatex',
}

/** Fin du log d'un moteur qui a écrit des pages (XeLaTeX écrit un .xdv, converti ensuite en PDF). */
const PDF_WRITTEN = /Output written on output\.(pdf|xdv)\b/

/** Sorties envoyées vers S3 (le fichier SyncTeX reste sur l'agent, sauf `uploadSynctex`). */
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
  sandbox: CompileSandbox
  binaries: BinarySource
  outputs: OutputStore
  logger: CompilerLogger
  /**
   * Envoie aussi `output.synctex.gz` (conteneur Cloudflare : la VM peut être recyclée entre la
   * compilation et une requête SyncTeX, le fichier est alors restauré depuis R2).
   */
  uploadSynctex?: boolean
}

const SYNCTEX_OUTPUT = { name: 'output.synctex.gz', contentType: 'application/gzip' }

export class InvalidRequestError extends Error {}

interface Running {
  controller: AbortController
  done: Promise<unknown>
}

function agentEntry(message: string): LogEntry {
  return { level: 'error', file: null, line: null, message, raw: '' }
}

/** Taille d'une sortie : un lien symbolique ou un fichier spécial compte comme absent. */
async function fileSize(path: string): Promise<number | null> {
  return regularFileSize(path)
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
    const visibleWorkdir = this.options.sandbox.workdirPath(paths.files)
    const workingDir = rootDir === '' ? visibleWorkdir : `${visibleWorkdir}/${rootDir}`
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
        workingDir,
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

    // Répertoire de sortie remplacé par un lien symbolique : aucune sortie n'est lue.
    const outputDirSafe =
      rootDir === '' ||
      (await assertSafeTarget(paths.files, rootDir).then(
        () => true,
        () => false,
      ))
    const pdfPath = join(outputDir, 'output.pdf')
    const logPath = join(outputDir, 'output.log')
    const blgPath = join(outputDir, 'output.blg')
    const pdfSize = outputDirSafe ? await fileSize(pdfPath) : null
    const logSize = outputDirSafe ? await fileSize(logPath) : null
    // Le répertoire garde les sorties précédentes (compilation incrémentale) : le PDF n'est envoyé
    // que si latexmk est allé au bout et que la dernière passe du moteur l'a bien produit. Sinon
    // (arrêt, timeout, erreur fatale sans page), ce serait le PDF d'une compilation antérieure.
    const log =
      logSize !== null && logSize <= OUTPUT_LIMITS.logBytes ? await readRegularFile(logPath) : null
    const pdfIsCurrent =
      result.outcome === 'exited' &&
      !result.oomKilled &&
      log !== null &&
      PDF_WRITTEN.test(log.subarray(-64 * 1024).toString('latin1'))
    let uploadPdf = pdfSize !== null && pdfIsCurrent
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
    if (status === 'success' && !uploadPdf) status = 'failure'

    if (uploadLog && log !== null) {
      const blg = await readRegularFile(blgPath)
      const parsed = parseCompileLogs({ log, blg }, { rootDir: workingDir })
      entries.unshift(
        ...parsed.map((entry) => ({ ...entry, file: projectFile(entry.file, rootDir) })),
      )
    }

    // 4. Envoi des sorties vers S3.
    const uploadStarted = performance.now()
    const outputFiles: OutputFile[] = []
    const uploaded = this.options.uploadSynctex
      ? [...UPLOADED_OUTPUTS, SYNCTEX_OUTPUT]
      : UPLOADED_OUTPUTS
    for (const output of uploaded) {
      if (output.name === 'output.pdf' && !uploadPdf) continue
      // Le SyncTeX ne vaut que pour le PDF envoyé.
      if (output.name === SYNCTEX_OUTPUT.name && !uploadPdf) continue
      if (output.name === 'output.log' && !uploadLog) continue
      const path = join(outputDir, output.name)
      const size = outputDirSafe ? await fileSize(path) : null
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
    workdir: string
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
    const visibleWorkdir = this.options.sandbox.workdirPath(paths.files)
    const result = await this.options.sandbox.run({
      command: ['synctex', ...args(rootDir)],
      hostWorkdir: paths.files,
      workingDir: rootDir === '' ? visibleWorkdir : `${visibleWorkdir}/${rootDir}`,
      readOnly: true,
      timeoutMs: SYNCTEX_TIMEOUT_MS,
      labels: { 'dev.kaxolax.project': projectId, 'dev.kaxolax.synctex': 'true' },
    })
    return result.outcome === 'exited'
      ? { output: result.output, rootDir, workdir: visibleWorkdir }
      : null
  }

  /** Le projet a un fichier SyncTeX (sinon, le conteneur Cloudflare le restaure depuis R2). */
  async hasSynctex(projectId: string): Promise<boolean> {
    const paths = projectPaths(this.options.compilesDir, projectId)
    const rootResourcePath = await readRootResourcePath(paths)
    if (rootResourcePath === null) return false
    const rootDir = rootDirectory(rootResourcePath)
    const directory = rootDir === '' ? paths.files : join(paths.files, rootDir)
    return (await fileSize(join(directory, 'output.synctex.gz'))) !== null
  }

  /** Remet en place le fichier SyncTeX d'une compilation précédente (hors compilation en cours). */
  async restoreSynctex(
    projectId: string,
    rootResourcePath: string,
    source: NodeJS.ReadableStream,
  ): Promise<void> {
    await this.exclusive(projectId, () =>
      restoreSynctex(projectPaths(this.options.compilesDir, projectId), rootResourcePath, source),
    )
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
    return {
      code: result === null ? [] : parseSynctexEdit(result.output, result.rootDir, result.workdir),
    }
  }
}
