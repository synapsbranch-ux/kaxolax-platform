import {
  agentCompileResponseSchema,
  type BuildStatus,
  clearCacheResponseSchema,
  type CompileRequest,
  compileRequestKey,
  compileRequestSchema,
  type ConvertFailure,
  convertFailureSchema,
  type ConvertRequest,
  convertResultSchema,
  DEFAULT_COMPILE_TIMEOUT_MS,
  isFinalBuildStatus,
  type LogEntry,
  type OutputFile,
  type WorkerCallback,
  type WorkerCompileJob,
  type WordCountRequest,
  wordCountResultSchema,
} from '@kaxolax/contracts'
import { z } from 'zod'
import type { CallbackOutcome } from './callback.js'

/**
 * Logique du Durable Object de compilation, indépendante du runtime : le conteneur, R2, le
 * stockage du Durable Object et l'envoi des rappels sont des ports (doubles dans les tests).
 */

/** Port de l'agent dans le conteneur (apps/compile-agent, container-main). */
export const CONTAINER_PORT = 8080

const CONTENT_TYPES: Record<string, string> = {
  'output.pdf': 'application/pdf',
  'output.log': 'text/plain; charset=utf-8',
  'output.blg': 'text/plain; charset=utf-8',
  'output.synctex.gz': 'application/gzip',
}

export interface StoredObject {
  body: ReadableStream
  size: number
}

/** Bucket R2 vu par le runner. */
export interface ObjectBucket {
  get(key: string): Promise<StoredObject | null>
  put(key: string, body: ReadableStream, size: number, contentType: string): Promise<void>
}

/** Conteneur du projet. `fetch` ajoute le jeton interne et prolonge l'activité. */
export interface ContainerPort {
  /** Vrai quand l'agent répond (un conteneur en cours de démarrage n'est pas prêt). */
  isRunning(): Promise<boolean>
  /** Démarre le conteneur si besoin et attend que l'agent écoute. */
  start(): Promise<void>
  fetch(path: string, init?: RequestInit): Promise<Response>
}

/** Stockage persistant du Durable Object (la file survit à une éviction entre deux alarmes). */
export interface JobStore {
  get<T>(key: string): Promise<T | undefined>
  put(key: string, value: unknown): Promise<void>
  delete(key: string): Promise<unknown>
}

export interface RunnerOptions {
  container: ContainerPort
  projectFiles: ObjectBucket
  outputs: ObjectBucket
  /** Nom du bucket des sorties : il doit être celui de la demande écrite par l'API. */
  outputBucketName: string
  store: JobStore
  sendCallback: (callback: WorkerCallback) => Promise<CallbackOutcome>
  /** Programme une tâche du Durable Object (alarme) dans `delaySeconds` secondes. */
  schedule: (delaySeconds: number, task: ScheduledTask) => Promise<void>
  agentId: string
  log?: (message: string, data?: Record<string, unknown>) => void
}

/** Tâches programmées par le runner (méthodes du Durable Object). */
export type ScheduledTask = 'drainQueue' | 'retryCallbacks'

const PENDING_KEY = 'pending'
/** Rappels finaux que l'API n'a pas reçus (redéploiement, panne) : réessayés par alarme. */
const UNDELIVERED_KEY = 'undelivered-callbacks'
export const CALLBACK_RETRY_SECONDS = 30
/**
 * Un rappel final est réessayé jusqu'au timeout de la compilation plus cette marge (celle de
 * `staleBuildMarginMs` dans l'API) : au-delà, l'API a clos la compilation et l'ignorerait.
 */
export const CALLBACK_RETRY_MARGIN_MS = 5 * 60_000

interface UndeliveredCallback {
  callback: WorkerCallback
  /** Horodatage (ms) après lequel le rappel est abandonné. */
  deadline: number
}
const missingResponseSchema = z.object({ missing: z.array(z.string()) })
const availableResponseSchema = z.object({ available: z.boolean() })

const json = (body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
})

function errorEntry(message: string): LogEntry {
  return { level: 'error', file: null, line: null, message, raw: '' }
}

/** Résultat d'un comptage de mots : compteurs, ou message de l'agent (texcount a échoué). */
export type WordCountOutcome =
  { ok: true; result: z.infer<typeof wordCountResultSchema> } | { ok: false; message: string }

const wordCountFailureSchema = z.object({ message: z.string() })

/** Résultat d'une conversion Markdown → LaTeX : sortie, ou échec décrit par l'agent (422). */
export type ConvertOutcome =
  { ok: true; result: z.infer<typeof convertResultSchema> } | { ok: false; failure: ConvertFailure }

export const MESSAGES = {
  startFailed: 'The compiler could not start. Try again in a moment.',
  compilerFailed: 'The compiler stopped unexpectedly. Try again in a moment.',
  invalidRequest: 'The compile request could not be read.',
} as const

export class CompileRunner {
  /** Compilation en cours dans cette instance (perdue avec elle : l'API la clôt au timeout). */
  private current: (WorkerCompileJob & { cancelled: boolean }) | null = null
  private draining = false

  constructor(private readonly options: RunnerOptions) {}

  private log(message: string, data?: Record<string, unknown>) {
    this.options.log?.(message, data)
  }

  /**
   * Met une compilation en file : une seule en attente (la plus récente). Une compilation en cours
   * d'un autre build est arrêtée (l'API n'en accepte qu'une à la fois par projet). Renvoie
   * `preparing` quand le conteneur doit d'abord démarrer.
   */
  async enqueue(job: WorkerCompileJob): Promise<'queued' | 'preparing'> {
    await this.options.store.put(PENDING_KEY, job)
    if (this.current && this.current.buildId !== job.buildId) {
      await this.cancel(this.current.buildId)
    }
    return (await this.options.container.isRunning()) ? 'queued' : 'preparing'
  }

  async cancel(buildId: string): Promise<void> {
    const pending = await this.options.store.get<WorkerCompileJob>(PENDING_KEY)
    if (pending?.buildId === buildId) await this.options.store.delete(PENDING_KEY)
    const current = this.current
    if (current?.buildId !== buildId) return
    // `/stop` même si le build est déjà marqué annulé : un arrêt demandé avant que latexmk ne
    // démarre (réveil, envoi des binaires) n'avait rien à arrêter.
    current.cancelled = true
    try {
      await this.options.container.fetch(`/projects/${current.projectId}/stop`, { method: 'POST' })
    } catch (error) {
      this.log('stop failed', { buildId, error: String(error) })
    }
  }

  /**
   * Traite une compilation de la file (alarme du Durable Object). Une seule par alarme : une
   * alarme est limitée à 15 minutes, et un utilisateur qui compile sans cesse la prolongerait
   * indéfiniment. La suivante est traitée dans une nouvelle alarme.
   */
  async drain(): Promise<void> {
    if (this.draining) return
    this.draining = true
    try {
      const job = await this.options.store.get<WorkerCompileJob>(PENDING_KEY)
      if (!job) return
      await this.options.store.delete(PENDING_KEY)
      this.current = { ...job, cancelled: false }
      try {
        await this.run(job)
      } finally {
        this.current = null
      }
    } finally {
      this.draining = false
    }
    if (await this.options.store.get<WorkerCompileJob>(PENDING_KEY)) {
      await this.options.schedule(0, 'drainQueue')
    }
  }

  /**
   * Réessaie les rappels finaux non reçus par l'API (alarme). Les rappels expirés sont abandonnés :
   * l'API a clos la compilation entre-temps. Les autres sont reprogrammés.
   */
  async retryCallbacks(): Promise<void> {
    const { store } = this.options
    const pending = (await store.get<UndeliveredCallback[]>(UNDELIVERED_KEY)) ?? []
    const done = new Set<string>()
    for (const { callback, deadline } of pending) {
      if (Date.now() > deadline) {
        this.log('final callback dropped', { buildId: callback.buildId })
        done.add(callback.buildId)
        continue
      }
      if ((await this.options.sendCallback(callback)) !== 'unreachable') {
        done.add(callback.buildId)
      }
    }
    // Relu après les envois : un rappel a pu être ajouté entre-temps.
    const remaining = ((await store.get<UndeliveredCallback[]>(UNDELIVERED_KEY)) ?? []).filter(
      (entry) => !done.has(entry.callback.buildId),
    )
    if (remaining.length === 0) {
      await store.delete(UNDELIVERED_KEY)
      return
    }
    await store.put(UNDELIVERED_KEY, remaining)
    await this.options.schedule(CALLBACK_RETRY_SECONDS, 'retryCallbacks')
  }

  /** Garde un rappel final non reçu pour `retryCallbacks`. */
  private async keepUndelivered(callback: WorkerCallback, deadline: number): Promise<void> {
    const { store } = this.options
    const pending = ((await store.get<UndeliveredCallback[]>(UNDELIVERED_KEY)) ?? []).filter(
      (entry) => entry.callback.buildId !== callback.buildId,
    )
    await store.put(UNDELIVERED_KEY, [...pending, { callback, deadline }])
    await this.options.schedule(CALLBACK_RETRY_SECONDS, 'retryCallbacks')
  }

  async warm(): Promise<void> {
    await this.options.container.start()
  }

  /** Vide le cache du projet ; un conteneur arrêté n'a plus de cache. */
  async clearCache(projectId: string): Promise<boolean> {
    if (!(await this.options.container.isRunning())) return true
    const response = await this.options.container.fetch(`/projects/${projectId}/clear-cache`, {
      method: 'POST',
    })
    if (!response.ok) throw new Error(`clear-cache answered ${String(response.status)}`)
    return clearCacheResponseSchema.parse(await response.json()).cleared
  }

  /**
   * Comptage de mots, synchrone : les documents texte sont dans la demande (aucun binaire à
   * pousser). Réveille le conteneur s'il dort ; l'agent attend la fin d'une compilation en cours
   * (une exécution à la fois dans la VM).
   */
  async wordCount(request: WordCountRequest): Promise<WordCountOutcome> {
    const { container } = this.options
    await container.start()
    const response = await container.fetch(
      `/projects/${request.projectId}/word-count`,
      json(request),
    )
    if (response.status === 422) {
      const failure = wordCountFailureSchema.safeParse(await response.json())
      return { ok: false, message: failure.success ? failure.data.message : 'Word count failed' }
    }
    if (!response.ok) throw new Error(`word count answered ${String(response.status)}`)
    return { ok: true, result: wordCountResultSchema.parse(await response.json()) }
  }

  /**
   * Conversion Markdown → LaTeX (pandoc dans le sandbox du conteneur), synchrone : le Markdown est
   * dans la demande, les images extraites dans la réponse (aucun accès à R2). Réveille le
   * conteneur s'il dort ; l'agent attend la fin d'une compilation en cours.
   */
  async convert(request: ConvertRequest): Promise<ConvertOutcome> {
    const { container } = this.options
    await container.start()
    const response = await container.fetch(`/projects/${request.projectId}/convert`, json(request))
    if (response.status === 422) {
      const failure = convertFailureSchema.safeParse(await response.json())
      return {
        ok: false,
        failure: failure.success
          ? failure.data
          : { error: 'convert_failed', reason: 'failed', message: 'Conversion failed' },
      }
    }
    if (!response.ok) throw new Error(`convert answered ${String(response.status)}`)
    return { ok: true, result: convertResultSchema.parse(await response.json()) }
  }

  /**
   * Requête SyncTeX. Si le conteneur a été recyclé depuis la compilation, son fichier SyncTeX est
   * restauré depuis R2. Null : aucune sortie pour ce build (404 côté API).
   */
  async synctex(
    projectId: string,
    kind: 'code' | 'pdf',
    query: Record<string, string>,
    buildId: string,
  ): Promise<unknown> {
    const { container } = this.options
    await container.start()
    const status = await container.fetch(`/projects/${projectId}/synctex/available`)
    if (!status.ok) throw new Error(`synctex status answered ${String(status.status)}`)
    if (!availableResponseSchema.parse(await status.json()).available) {
      if (!(await this.restoreSynctex(projectId, buildId))) return null
    }
    const params = new URLSearchParams(query)
    const response = await container.fetch(
      `/projects/${projectId}/synctex/${kind}?${params.toString()}`,
    )
    if (!response.ok) throw new Error(`synctex answered ${String(response.status)}`)
    return response.json()
  }

  private async restoreSynctex(projectId: string, buildId: string): Promise<boolean> {
    const synctex = await this.options.outputs.get(
      `outputs/${projectId}/${buildId}/output.synctex.gz`,
    )
    if (!synctex) return false
    const request = await this.readRequest({
      projectId,
      buildId,
      requestKey: compileRequestKey(projectId, buildId),
    })
    if (typeof request === 'string') {
      await synctex.body.cancel()
      return false
    }
    const params = new URLSearchParams({ root: request.rootResourcePath })
    const response = await this.options.container.fetch(
      `/projects/${projectId}/synctex?${params.toString()}`,
      { method: 'PUT', headers: { 'content-type': 'application/gzip' }, body: synctex.body },
    )
    return response.ok
  }

  /** Demande complète écrite par l'API dans R2, vérifiée ; un message d'erreur sinon. */
  private async readRequest(job: WorkerCompileJob): Promise<CompileRequest | string> {
    if (job.requestKey !== compileRequestKey(job.projectId, job.buildId)) {
      return MESSAGES.invalidRequest
    }
    const object = await this.options.outputs.get(job.requestKey)
    if (!object) return MESSAGES.invalidRequest
    let parsed: unknown
    try {
      parsed = JSON.parse(await new Response(object.body).text())
    } catch {
      return MESSAGES.invalidRequest
    }
    const request = compileRequestSchema.safeParse(parsed)
    if (
      !request.success ||
      request.data.projectId !== job.projectId ||
      request.data.buildId !== job.buildId ||
      request.data.output.bucket !== this.options.outputBucketName
    ) {
      return MESSAGES.invalidRequest
    }
    return request.data
  }

  /** Envoie au conteneur les binaires absents de son cache, lus dans R2 ; un message sinon. */
  private async pushBinaries(request: CompileRequest): Promise<string | null> {
    const { container, projectFiles } = this.options
    const bySha = new Map<string, { path: string; s3Key: string }>()
    for (const resource of request.resources) {
      if (resource.kind === 'binary' && !bySha.has(resource.sha256))
        bySha.set(resource.sha256, resource)
    }
    if (bySha.size === 0) return null
    const response = await container.fetch('/blobs/missing', json({ sha256: [...bySha.keys()] }))
    if (!response.ok) throw new Error(`blobs/missing answered ${String(response.status)}`)
    for (const sha256 of missingResponseSchema.parse(await response.json()).missing) {
      const resource = bySha.get(sha256)
      if (!resource) continue
      const object = await projectFiles.get(resource.s3Key)
      if (!object) return `Missing project file: ${resource.path}`
      const pushed = await container.fetch(`/blobs/${sha256}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/octet-stream' },
        body: object.body,
      })
      if (pushed.status === 400) return `Project file is corrupted: ${resource.path}`
      if (!pushed.ok) throw new Error(`blob upload answered ${String(pushed.status)}`)
    }
    return null
  }

  /**
   * Copie les sorties du conteneur dans R2, puis les supprime du conteneur. Le conteneur n'est pas
   * fiable (la VM est la frontière) : seuls les fichiers attendus, sous le préfixe du build, sont
   * écrits avec le binding R2 du Worker.
   */
  private async copyOutputs(request: CompileRequest, files: OutputFile[]): Promise<OutputFile[]> {
    const copied: OutputFile[] = []
    const prefix = `outputs/${request.projectId}/${request.buildId}/`
    for (const file of files) {
      if (!Object.hasOwn(CONTENT_TYPES, file.name) || file.s3Key !== `${prefix}${file.name}`) {
        this.log('unexpected output ignored', { buildId: request.buildId, key: file.s3Key })
        continue
      }
      const response = await this.options.container.fetch(`/outputs/${file.s3Key}`)
      if (!response.ok || response.body === null) {
        this.log('output missing in the container', { key: file.s3Key })
        continue
      }
      await this.options.outputs.put(
        file.s3Key,
        response.body,
        file.sizeBytes,
        CONTENT_TYPES[file.name] ?? 'application/octet-stream',
      )
      copied.push(file)
    }
    await this.options.container
      .fetch(`/outputs/${request.projectId}/${request.buildId}`, { method: 'DELETE' })
      .catch(() => undefined)
    return copied
  }

  /**
   * Exécute une compilation. Toute exception (R2, état du conteneur…) se termine par un rappel
   * `error` : l'alarme du Durable Object l'avalerait, et l'API attendrait jusqu'au timeout.
   */
  private async run(job: WorkerCompileJob): Promise<void> {
    const started = Date.now()
    let seq = 0
    // Objet plutôt que variable : l'affectation dans `send` échappe à l'analyse de flux.
    // `timeoutMs` : celui de la demande, une fois lue (délai de nouvelle tentative du rappel final).
    const progress = { finalSent: false, timeoutMs: DEFAULT_COMPILE_TIMEOUT_MS }
    const send = async (
      status: Exclude<BuildStatus, 'queued'>,
      extra: Partial<WorkerCallback> = {},
    ) => {
      seq += 1
      const final = isFinalBuildStatus(status)
      if (final) progress.finalSent = true
      const callback: WorkerCallback = {
        projectId: job.projectId,
        buildId: job.buildId,
        seq,
        status,
        agentId: this.options.agentId,
        ...extra,
      }
      const outcome = await this.options.sendCallback(callback)
      // Sorties déjà dans R2 : le résultat final ne doit pas se perdre pendant une panne de l'API.
      if (final && outcome === 'unreachable') {
        await this.keepUndelivered(
          callback,
          started + progress.timeoutMs + CALLBACK_RETRY_MARGIN_MS,
        )
      }
    }
    const finish = async (status: 'error' | 'cancelled', message?: string) => {
      await send(status, {
        durationMs: Date.now() - started,
        entries: message === undefined ? [] : [errorEntry(message)],
      })
    }
    const cancelled = () => this.current?.cancelled === true

    try {
      await this.execute(job, { send, finish, cancelled, progress })
    } catch (error) {
      this.log('compile failed', { buildId: job.buildId, error: String(error) })
      if (!progress.finalSent) await finish('error', MESSAGES.compilerFailed)
    }
  }

  private async execute(
    job: WorkerCompileJob,
    steps: {
      send: (
        status: Exclude<BuildStatus, 'queued'>,
        extra?: Partial<WorkerCallback>,
      ) => Promise<void>
      finish: (status: 'error' | 'cancelled', message?: string) => Promise<void>
      cancelled: () => boolean
      progress: { timeoutMs: number }
    },
  ): Promise<void> {
    const { send, finish, cancelled } = steps
    const request = await this.readRequest(job)
    if (typeof request === 'string') {
      await finish('error', request)
      return
    }
    steps.progress.timeoutMs = request.timeoutMs
    if (!(await this.options.container.isRunning())) await send('preparing')
    try {
      await this.options.container.start()
    } catch (error) {
      this.log('container start failed', { buildId: job.buildId, error: String(error) })
      await finish('error', MESSAGES.startFailed)
      return
    }
    if (cancelled()) {
      await finish('cancelled')
      return
    }
    await send('running')

    try {
      const problem = await this.pushBinaries(request)
      if (problem !== null) {
        await finish('error', problem)
        return
      }
      // Arrêt demandé pendant le réveil ou l'envoi des binaires : latexmk ne démarre pas.
      if (cancelled()) {
        await finish('cancelled')
        return
      }
      const response = await this.options.container.fetch(
        `/projects/${request.projectId}/compile`,
        json(request),
      )
      if (!response.ok) throw new Error(`compile answered ${String(response.status)}`)
      const result = agentCompileResponseSchema.parse(await response.json())
      const outputFiles = await this.copyOutputs(request, result.outputFiles)
      if (cancelled()) {
        await finish('cancelled')
        return
      }
      await send(result.status, {
        durationMs: result.durationMs,
        entries: result.entries,
        outputFiles,
      })
    } catch (error) {
      this.log('compile failed', { buildId: job.buildId, error: String(error) })
      await finish(
        cancelled() ? 'cancelled' : 'error',
        cancelled() ? undefined : MESSAGES.compilerFailed,
      )
    }
  }
}
