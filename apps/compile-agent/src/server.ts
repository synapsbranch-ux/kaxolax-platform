import { timingSafeEqual } from 'node:crypto'
import {
  agentCompileResponseSchema,
  type AgentHealth,
  clearCacheResponseSchema,
  compileRequestSchema,
  type ConvertFailure,
  convertRequestSchema,
  convertResultSchema,
  INTERNAL_TOKEN_HEADER,
  stopCompileResponseSchema,
  synctexCodeQuerySchema,
  synctexPdfQuerySchema,
  wordCountRequestSchema,
  wordCountResultSchema,
} from '@kaxolax/contracts'
import Fastify from 'fastify'
import { type Logger } from 'pino'
import { z, ZodError } from 'zod'
import {
  type Compiler,
  ConvertBusyError,
  InvalidRequestError,
  WordCountBusyError,
  WordCountError,
} from './compiler.js'
import { ConvertError } from './convert.js'

const projectParamsSchema = z.object({ projectId: z.uuid() })

/** Une demande de compilation porte le contenu des documents : jusqu'à plusieurs dizaines de Mo. */
const BODY_LIMIT_BYTES = 200 * 1024 * 1024

export interface ServerOptions {
  compiler: Compiler
  internalToken: string
  logger: Logger
}

function tokenMatches(expected: Buffer, provided: string | string[] | undefined): boolean {
  if (typeof provided !== 'string') return false
  const candidate = Buffer.from(provided)
  return candidate.length === expected.length && timingSafeEqual(candidate, expected)
}

/** Service HTTP interne de l'agent (jamais exposé publiquement). */
export function buildServer(options: ServerOptions) {
  const app = Fastify({ loggerInstance: options.logger, bodyLimit: BODY_LIMIT_BYTES })
  const expectedToken = Buffer.from(options.internalToken)

  app.addHook('onRequest', async (request, reply) => {
    if (!tokenMatches(expectedToken, request.headers[INTERNAL_TOKEN_HEADER])) {
      await reply.code(401).send({ error: 'unauthorized' })
    }
  })

  app.setErrorHandler(async (error, _request, reply) => {
    if (error instanceof ZodError) {
      await reply.code(400).send({ error: 'invalid_request', issues: error.issues })
      return
    }
    if (error instanceof WordCountError) {
      await reply.code(422).send({ error: 'word_count_failed', message: error.message })
      return
    }
    if (error instanceof WordCountBusyError) {
      await reply.code(503).send({ error: 'word_count_busy', message: error.message })
      return
    }
    if (error instanceof ConvertError) {
      const failure: ConvertFailure = {
        error: 'convert_failed',
        reason: error.reason,
        message: error.message,
      }
      await reply.code(422).send(failure)
      return
    }
    if (error instanceof ConvertBusyError) {
      await reply.code(503).send({ error: 'convert_busy', message: error.message })
      return
    }
    if (error instanceof InvalidRequestError) {
      await reply.code(400).send({ error: 'invalid_request', message: error.message })
      return
    }
    app.log.error(error)
    const statusCode = (error as { statusCode?: number }).statusCode
    await reply.code(statusCode !== undefined && statusCode < 500 ? statusCode : 500).send({
      error: statusCode !== undefined && statusCode < 500 ? 'bad_request' : 'internal_error',
    })
  })

  app.get('/health', (): AgentHealth => options.compiler.health())

  app.post('/projects/:projectId/compile', async (request) => {
    const { projectId } = projectParamsSchema.parse(request.params)
    const body = compileRequestSchema.parse(request.body)
    if (body.projectId !== projectId) {
      throw new InvalidRequestError('projectId in the path and in the body differ')
    }
    return agentCompileResponseSchema.parse(await options.compiler.compile(body))
  })

  app.post('/projects/:projectId/word-count', async (request) => {
    const { projectId } = projectParamsSchema.parse(request.params)
    const body = wordCountRequestSchema.parse(request.body)
    if (body.projectId !== projectId) {
      throw new InvalidRequestError('projectId in the path and in the body differ')
    }
    return wordCountResultSchema.parse(await options.compiler.wordCount(body))
  })

  app.post('/projects/:projectId/convert', async (request) => {
    const { projectId } = projectParamsSchema.parse(request.params)
    const body = convertRequestSchema.parse(request.body)
    if (body.projectId !== projectId) {
      throw new InvalidRequestError('projectId in the path and in the body differ')
    }
    return convertResultSchema.parse(await options.compiler.convert(body))
  })

  app.post('/projects/:projectId/stop', async (request) => {
    const { projectId } = projectParamsSchema.parse(request.params)
    return stopCompileResponseSchema.parse({ stopped: await options.compiler.stop(projectId) })
  })

  app.post('/projects/:projectId/clear-cache', async (request) => {
    const { projectId } = projectParamsSchema.parse(request.params)
    return clearCacheResponseSchema.parse({ cleared: await options.compiler.clearCache(projectId) })
  })

  app.get('/projects/:projectId/synctex/code', async (request) => {
    const { projectId } = projectParamsSchema.parse(request.params)
    return options.compiler.synctexFromCode(projectId, synctexCodeQuerySchema.parse(request.query))
  })

  app.get('/projects/:projectId/synctex/pdf', async (request) => {
    const { projectId } = projectParamsSchema.parse(request.params)
    return options.compiler.synctexFromPdf(projectId, synctexPdfQuerySchema.parse(request.query))
  })

  return app
}
