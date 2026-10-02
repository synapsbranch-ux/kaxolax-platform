import { Container } from '@cloudflare/containers'
import {
  INTERNAL_TOKEN_HEADER,
  type WorkerCompileJob,
  type WorkerEnqueueResponse,
  type WordCountRequest,
} from '@kaxolax/contracts'
import { sendCallback } from './callback.js'
import type { Env } from './env.js'
import {
  CONTAINER_PORT,
  CompileRunner,
  type ObjectBucket,
  type WordCountOutcome,
} from './runner.js'

const TOKEN_KEY = 'container-token'
const PROJECT_KEY = 'project-id'
/** Démarrage de la VM et de l'agent (image TeX Live de plusieurs Go au premier démarrage). */
const START_TIMEOUT_MS = 180_000

function log(message: string, data?: Record<string, unknown>) {
  console.log(JSON.stringify({ message, ...data }))
}

function randomToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32))
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

/** R2 vu par le runner : une écriture en flux exige une longueur connue (FixedLengthStream). */
function r2Bucket(bucket: R2Bucket): ObjectBucket {
  return {
    async get(key) {
      const object = await bucket.get(key)
      return object ? { body: object.body, size: object.size } : null
    },
    async put(key, body, size, contentType) {
      const fixed = new FixedLengthStream(size)
      await Promise.all([
        body.pipeTo(fixed.writable),
        bucket.put(key, fixed.readable, { httpMetadata: { contentType } }),
      ])
    },
  }
}

/**
 * Durable Object d'un projet (nom = projectId) et son conteneur de compilation : VM isolée, sans
 * réseau, mise en sommeil 15 minutes après la dernière activité. L'agent du conteneur n'accepte
 * que le jeton tiré au hasard ici et passé au démarrage.
 */
export class CompileContainer extends Container<Env> {
  override defaultPort = CONTAINER_PORT
  override sleepAfter = '15m'
  override enableInternet = false
  private token = ''
  private readonly runner: CompileRunner

  constructor(ctx: ConstructorParameters<typeof Container<Env>>[0], env: Env) {
    super(ctx, env)
    void ctx.blockConcurrencyWhile(async () => {
      let token = await ctx.storage.get<string>(TOKEN_KEY)
      if (token === undefined) {
        token = randomToken()
        await ctx.storage.put(TOKEN_KEY, token)
      }
      this.token = token
      this.envVars = {
        INTERNAL_TOKEN: token,
        OUTPUT_BUCKET: env.OUTPUTS_BUCKET_NAME,
        AGENT_ID: `cf-${ctx.id.toString().slice(0, 16)}`,
      }
    })
    this.runner = new CompileRunner({
      container: {
        // Prêt seulement quand l'agent répond : `running` = VM démarrée, agent pas encore à l'écoute.
        isRunning: async () => (await this.getState()).status === 'healthy',
        start: () =>
          this.startAndWaitForPorts({
            ports: CONTAINER_PORT,
            cancellationOptions: { portReadyTimeoutMS: START_TIMEOUT_MS },
          }),
        fetch: (path, init) => {
          const headers = new Headers(init?.headers)
          headers.set(INTERNAL_TOKEN_HEADER, this.token)
          return this.containerFetch(
            `http://container${path}`,
            { ...init, headers },
            CONTAINER_PORT,
          )
        },
      },
      projectFiles: r2Bucket(env.PROJECT_FILES),
      outputs: r2Bucket(env.COMPILE_OUTPUTS),
      outputBucketName: env.OUTPUTS_BUCKET_NAME,
      store: ctx.storage,
      sendCallback: (callback) =>
        sendCallback(callback, {
          url: env.API_CALLBACK_URL,
          secret: env.COMPILE_WORKER_SECRET,
          log,
        }),
      schedule: async (delaySeconds, task) => {
        await this.schedule(delaySeconds, task)
      },
      agentId: `cf-${ctx.id.toString().slice(0, 16)}`,
      log,
    })
  }

  private async projectId(): Promise<string> {
    const projectId = await this.ctx.storage.get<string>(PROJECT_KEY)
    if (projectId === undefined) throw new Error('unknown project')
    return projectId
  }

  /** Met la compilation en file puis la traite dans une alarme (une compilation par alarme). */
  async enqueue(job: WorkerCompileJob): Promise<WorkerEnqueueResponse> {
    await this.ctx.storage.put(PROJECT_KEY, job.projectId)
    const status = await this.runner.enqueue(job)
    await this.schedule(0, 'drainQueue')
    return { buildId: job.buildId, status }
  }

  async drainQueue(): Promise<void> {
    await this.runner.drain()
  }

  async retryCallbacks(): Promise<void> {
    await this.runner.retryCallbacks()
  }

  async cancel(buildId: string): Promise<void> {
    await this.runner.cancel(buildId)
  }

  /** Réveil anticipé : le démarrage se fait dans une alarme, la réponse est immédiate. */
  async warm(projectId: string): Promise<void> {
    await this.ctx.storage.put(PROJECT_KEY, projectId)
    await this.schedule(0, 'warmUp')
  }

  async warmUp(): Promise<void> {
    await this.runner.warm()
  }

  async clearCache(): Promise<boolean> {
    const projectId = await this.ctx.storage.get<string>(PROJECT_KEY)
    return projectId === undefined ? true : this.runner.clearCache(projectId)
  }

  async wordCount(request: WordCountRequest): Promise<WordCountOutcome> {
    await this.ctx.storage.put(PROJECT_KEY, request.projectId)
    return this.runner.wordCount(request)
  }

  async synctex(
    kind: 'code' | 'pdf',
    query: Record<string, string>,
    buildId: string,
  ): Promise<unknown> {
    return this.runner.synctex(await this.projectId(), kind, query, buildId)
  }
}
