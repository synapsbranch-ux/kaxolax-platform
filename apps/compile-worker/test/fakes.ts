import {
  type AgentCompileResponse,
  type CompileRequest,
  compileOutputPrefix,
  compileRequestKey,
  projectFilesPrefix,
  type WorkerCallback,
} from '@kaxolax/contracts'
import type { CallbackOutcome } from '../src/callback.js'
import {
  type ContainerPort,
  type JobStore,
  type ObjectBucket,
  type ScheduledTask,
} from '../src/runner.js'

export const projectId = '6f1c2d3e-4b5a-4c7d-8e9f-0a1b2c3d4e5f'
export const buildId = '0b8f7e6d-5c4b-4a39-8281-7f6e5d4c3b2a'
export const otherBuildId = '1c9e8d7f-6a5b-4c3d-9e2f-1a2b3c4d5e6f'
export const OUTPUT_BUCKET = 'kaxolax-compile-outputs'
export const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3])
export const PNG_SHA = 'b'.repeat(64)

const encoder = new TextEncoder()

async function bytesOf(body: BodyInit | null | undefined): Promise<Uint8Array> {
  return new Uint8Array(await new Response(body ?? null).arrayBuffer())
}

/** Bucket R2 en mémoire. */
export class MemoryBucket implements ObjectBucket {
  objects = new Map<string, { data: Uint8Array; contentType: string }>()

  set(key: string, data: Uint8Array | string, contentType = 'application/octet-stream') {
    this.objects.set(key, {
      data: typeof data === 'string' ? encoder.encode(data) : data,
      contentType,
    })
  }

  text(key: string): string | undefined {
    const object = this.objects.get(key)
    return object && new TextDecoder().decode(object.data)
  }

  /** Simule une panne de R2 en lecture. */
  failGet = false

  get(key: string) {
    if (this.failGet) return Promise.reject(new Error('R2 unavailable'))
    const object = this.objects.get(key)
    if (!object) return Promise.resolve(null)
    const body = new Response(object.data).body
    if (body === null) throw new Error('empty body')
    return Promise.resolve({ body, size: object.data.byteLength })
  }

  async put(key: string, body: ReadableStream, size: number, contentType: string) {
    const data = await bytesOf(body)
    if (data.byteLength !== size) throw new Error(`size mismatch for ${key}`)
    this.objects.set(key, { data, contentType })
  }
}

export class MemoryStore implements JobStore {
  values = new Map<string, unknown>()

  get<T>(key: string) {
    return Promise.resolve(this.values.get(key) as T | undefined)
  }

  put(key: string, value: unknown) {
    this.values.set(key, structuredClone(value))
    return Promise.resolve()
  }

  delete(key: string) {
    return Promise.resolve(this.values.delete(key))
  }
}

interface Call {
  method: string
  path: string
}

/** Agent du conteneur simulé (mêmes routes que container-server de apps/compile-agent). */
export class FakeContainer implements ContainerPort {
  running = false
  failStart = false
  calls: Call[] = []
  blobs = new Map<string, Uint8Array>()
  compiled: CompileRequest[] = []
  synctexAvailable = false
  restoredRoot: string | null = null
  outputs = new Map<string, Uint8Array>()
  /** Compilation bloquée jusqu'à `release()` (tests d'annulation). */
  private gate: Promise<void> | null = null
  private open: (() => void) | null = null
  stopped = false
  /** Bloque aussi l'envoi des binaires (annulation avant le lancement de latexmk). */
  holdBlobs = false
  /** Réponse de la route word-count de l'agent (succès par défaut). */
  wordCountReply: { status: number; body: unknown } | null = null
  /** Réponse de la route convert de l'agent (succès par défaut). */
  convertReply: { status: number; body: unknown } | null = null
  /** Sorties supplémentaires annoncées par un agent compromis. */
  extraOutputs: { name: string; s3Key: string; content: string }[] = []

  hold() {
    this.gate = new Promise((resolve) => {
      this.open = resolve
    })
  }

  release() {
    this.open?.()
  }

  /** Lu après l'attente : un arrêt a pu arriver entre-temps. */
  private wasStopped() {
    return this.stopped
  }

  isRunning() {
    return Promise.resolve(this.running)
  }

  start() {
    if (this.failStart) return Promise.reject(new Error('no capacity'))
    this.running = true
    return Promise.resolve()
  }

  called(method: string, prefix: string) {
    return this.calls.filter((call) => call.method === method && call.path.startsWith(prefix))
  }

  async fetch(path: string, init: RequestInit = {}): Promise<Response> {
    const method = init.method ?? 'GET'
    this.calls.push({ method, path })
    const url = new URL(path, 'http://container')
    const json = (body: unknown, status = 200) => Response.json(body, { status })
    if (method === 'POST' && url.pathname === '/blobs/missing') {
      const { sha256 } = await new Response(init.body).json<{ sha256: string[] }>()
      if (this.holdBlobs && this.gate) await this.gate
      return json({ missing: sha256.filter((hash) => !this.blobs.has(hash)) })
    }
    if (method === 'PUT' && url.pathname.startsWith('/blobs/')) {
      this.blobs.set(url.pathname.slice('/blobs/'.length), await bytesOf(init.body))
      return new Response(null, { status: 204 })
    }
    if (method === 'POST' && url.pathname.endsWith('/compile')) {
      const request = await new Response(init.body).json<CompileRequest>()
      this.compiled.push(request)
      this.stopped = false
      if (this.gate) await this.gate
      const stopped = this.wasStopped()
      const prefix = request.output.prefix
      const files = { 'output.pdf': '%PDF-1.7', 'output.log': 'log', 'output.synctex.gz': 'stx' }
      for (const [name, content] of Object.entries(files)) {
        this.outputs.set(`${prefix}${name}`, encoder.encode(content))
      }
      for (const extra of this.extraOutputs) {
        this.outputs.set(extra.s3Key, encoder.encode(extra.content))
      }
      this.synctexAvailable = true
      const response: AgentCompileResponse = {
        buildId: request.buildId,
        status: stopped ? 'error' : 'success',
        durationMs: 1500,
        outputFiles: [
          ...Object.entries(files).map(([name, content]) => ({
            name,
            s3Key: `${prefix}${name}`,
            sizeBytes: content.length,
          })),
          ...this.extraOutputs.map(({ name, s3Key, content }) => ({
            name,
            s3Key,
            sizeBytes: content.length,
          })),
        ],
        entries: stopped
          ? [{ level: 'error', file: null, line: null, message: 'Compilation stopped', raw: '' }]
          : [],
        timings: { syncMs: 1, runMs: 1, uploadMs: 1 },
      }
      return json(response)
    }
    if (method === 'POST' && url.pathname.endsWith('/stop')) {
      this.stopped = true
      this.release()
      return json({ stopped: true })
    }
    if (method === 'GET' && url.pathname.startsWith('/outputs/')) {
      const data = this.outputs.get(url.pathname.slice('/outputs/'.length))
      return data ? new Response(data) : json({ error: 'not_found' }, 404)
    }
    if (method === 'DELETE' && url.pathname.startsWith('/outputs/')) {
      return new Response(null, { status: 204 })
    }
    if (url.pathname.endsWith('/synctex/available')) {
      return json({ available: this.synctexAvailable })
    }
    if (method === 'PUT' && url.pathname.endsWith('/synctex')) {
      this.restoredRoot = url.searchParams.get('root')
      this.synctexAvailable = (await bytesOf(init.body)).byteLength > 0
      return new Response(null, { status: 204 })
    }
    if (url.pathname.endsWith('/synctex/code')) {
      return json({ pdf: [{ page: 1, h: 1, v: 2, width: 3, height: 4 }], query: url.search })
    }
    if (url.pathname.endsWith('/clear-cache')) return json({ cleared: true })
    if (method === 'POST' && url.pathname.endsWith('/word-count')) {
      if (this.wordCountReply) return json(this.wordCountReply.body, this.wordCountReply.status)
      const total = {
        words: 2,
        text: 2,
        headers: 0,
        captions: 0,
        headerCount: 0,
        floatCount: 0,
        inlineMathCount: 0,
        displayMathCount: 0,
      }
      return json({ total, sections: [], warnings: [] })
    }
    if (method === 'POST' && url.pathname.endsWith('/convert')) {
      if (this.convertReply) return json(this.convertReply.body, this.convertReply.status)
      return json({
        latex: '\\section{Bonjour}\n',
        preamble: null,
        title: 'Bonjour',
        media: [],
        images: [],
        warnings: [],
        durationMs: 5,
      })
    }
    return json({ error: 'not_found' }, 404)
  }
}

/** Demande de compilation telle que l'API l'écrit dans R2. */
export function compileRequest(id = buildId, root = 'thesis/main.tex'): CompileRequest {
  return {
    projectId,
    buildId: id,
    compiler: 'pdflatex',
    rootResourcePath: root,
    timeoutMs: 20_000,
    resources: [
      { path: root, kind: 'text', content: '\\documentclass{article}', sha256: 'a'.repeat(64) },
      {
        path: 'plot.png',
        kind: 'binary',
        s3Key: `${projectFilesPrefix(projectId)}files/plot`,
        sha256: PNG_SHA,
      },
    ],
    output: { bucket: OUTPUT_BUCKET, prefix: compileOutputPrefix(projectId, id) },
  }
}

export function job(id = buildId) {
  return { projectId, buildId: id, requestKey: compileRequestKey(projectId, id) }
}

/** Rappels envoyés ; `outcomes` simule les réponses de l'API (reçu par défaut). */
export function callbacksRecorder() {
  const callbacks: WorkerCallback[] = []
  const outcomes: CallbackOutcome[] = []
  return {
    callbacks,
    outcomes,
    send: (callback: WorkerCallback) => {
      callbacks.push(callback)
      return Promise.resolve(outcomes.shift() ?? 'delivered')
    },
  }
}

/** Tâches programmées par le runner (alarmes du Durable Object). */
export function scheduleRecorder() {
  const scheduled: [number, ScheduledTask][] = []
  return {
    scheduled,
    schedule: (delaySeconds: number, task: ScheduledTask) => {
      scheduled.push([delaySeconds, task])
      return Promise.resolve()
    },
  }
}
