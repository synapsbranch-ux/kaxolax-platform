import {
  compileRequestKey,
  type ConvertRequest,
  convertRequestSchema,
  verifyCompileWorkerToken,
  workerCancelSchema,
  workerCompileJobSchema,
  type WorkerCompileJob,
  type WorkerEnqueueResponse,
  type WordCountRequest,
  wordCountRequestSchema,
  workerSynctexCodeQuerySchema,
  workerSynctexPdfQuerySchema,
} from '@kaxolax/contracts'
import { ZodError } from 'zod'
import type { ConvertOutcome, WordCountOutcome } from './runner.js'

/** Opérations du Durable Object d'un projet, vues par le Worker. */
export interface ProjectCompiler {
  enqueue(job: WorkerCompileJob): Promise<WorkerEnqueueResponse>
  cancel(buildId: string): Promise<void>
  warm(): Promise<void>
  clearCache(): Promise<boolean>
  /** Null : pas de sortie SyncTeX pour ce build. */
  synctex(kind: 'code' | 'pdf', query: Record<string, string>, buildId: string): Promise<unknown>
  /** Comptage de mots (texcount dans le conteneur), synchrone. */
  wordCount(request: WordCountRequest): Promise<WordCountOutcome>
  /** Conversion Markdown → LaTeX (pandoc dans le conteneur), synchrone. */
  convert(request: ConvertRequest): Promise<ConvertOutcome>
}

export interface RouterOptions {
  secret: string
  compilerFor(projectId: string): ProjectCompiler
  log?: (message: string, data?: Record<string, unknown>) => void
}

const ROUTE =
  /^\/projects\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/(compile|cancel|warm|clear-cache|synctex\/code|synctex\/pdf|word-count|convert)$/

const METHODS: Record<string, string> = {
  compile: 'POST',
  cancel: 'POST',
  warm: 'POST',
  'clear-cache': 'POST',
  'synctex/code': 'GET',
  'synctex/pdf': 'GET',
  'word-count': 'POST',
  convert: 'POST',
}

function reply(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })
}

/**
 * Point d'entrée HTTP du Worker, appelé par l'API seulement : chaque requête porte un jeton HMAC
 * de 60 s lié au projet de l'URL. Le Durable Object du projet fait le reste.
 */
export async function handleRequest(request: Request, options: RouterOptions): Promise<Response> {
  const url = new URL(request.url)
  if (url.pathname === '/health' && request.method === 'GET') return reply(200, { status: 'ok' })
  const match = ROUTE.exec(url.pathname)
  const projectId = match?.[1]
  const action = match?.[2]
  if (projectId === undefined || action === undefined) return reply(404, { error: 'not_found' })
  if (METHODS[action] !== request.method) return reply(405, { error: 'method_not_allowed' })

  const authorization = request.headers.get('authorization') ?? ''
  const token = authorization.startsWith('Bearer ') ? authorization.slice(7) : ''
  const claims = await verifyCompileWorkerToken(token, options.secret)
  if (claims?.projectId !== projectId) return reply(401, { error: 'unauthorized' })

  const compiler = options.compilerFor(projectId)
  try {
    switch (action) {
      case 'compile': {
        const job = workerCompileJobSchema.parse(await request.json())
        if (
          job.projectId !== projectId ||
          job.requestKey !== compileRequestKey(projectId, job.buildId)
        ) {
          return reply(400, { error: 'invalid_request' })
        }
        return reply(202, await compiler.enqueue(job))
      }
      case 'cancel': {
        const { buildId } = workerCancelSchema.parse(await request.json())
        await compiler.cancel(buildId)
        return reply(202, { cancelled: true })
      }
      case 'warm':
        await compiler.warm()
        return reply(202, { status: 'warming' })
      case 'clear-cache':
        return reply(200, { cleared: await compiler.clearCache() })
      case 'word-count': {
        const body = wordCountRequestSchema.parse(await request.json())
        if (body.projectId !== projectId) return reply(400, { error: 'invalid_request' })
        const outcome = await compiler.wordCount(body)
        return outcome.ok
          ? reply(200, outcome.result)
          : reply(422, { error: 'word_count_failed', message: outcome.message })
      }
      case 'convert': {
        const body = convertRequestSchema.parse(await request.json())
        if (body.projectId !== projectId) return reply(400, { error: 'invalid_request' })
        const outcome = await compiler.convert(body)
        return outcome.ok ? reply(200, outcome.result) : reply(422, outcome.failure)
      }
      default: {
        const params = Object.fromEntries(url.searchParams)
        const kind = action === 'synctex/code' ? 'code' : 'pdf'
        const { buildId, ...query } =
          kind === 'code'
            ? workerSynctexCodeQuerySchema.parse(params)
            : workerSynctexPdfQuerySchema.parse(params)
        const result = await compiler.synctex(
          kind,
          Object.fromEntries(Object.entries(query).map(([key, value]) => [key, String(value)])),
          buildId,
        )
        return result === null ? reply(404, { error: 'no_output' }) : reply(200, result)
      }
    }
  } catch (error) {
    if (error instanceof ZodError || error instanceof SyntaxError) {
      return reply(400, { error: 'invalid_request' })
    }
    options.log?.('request failed', { action, projectId, error: String(error) })
    return reply(503, { error: 'unavailable' })
  }
}
