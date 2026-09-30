import { createHash, timingSafeEqual } from 'node:crypto'
import {
  clearCacheResponseSchema,
  compileRequestSchema,
  INTERNAL_TOKEN_HEADER,
  stopCompileResponseSchema,
  synctexCodeQuerySchema,
  synctexPdfQuerySchema,
} from '@kaxolax/contracts'
import Fastify from 'fastify'
import type { Logger } from 'pino'
import { z, ZodError } from 'zod'
import { type AgentPool, AgentResponseError, AgentUnreachableError } from './agents.js'
import { type CompileRouter, NoAgentAvailableError, NoCompileOutputError } from './router.js'

const projectParamsSchema = z.object({ projectId: z.uuid() })

/** Même plafond que l'agent : une demande porte le contenu des documents. */
const BODY_LIMIT_BYTES = 200 * 1024 * 1024

function sameSecret(received: string | string[] | undefined, expected: string): boolean {
  if (typeof received !== 'string') return false
  const digest = (value: string) => createHash('sha256').update(value).digest()
  return timingSafeEqual(digest(received), digest(expected))
}

export interface ServerOptions {
  router: CompileRouter
  pool: AgentPool
  internalToken: string
  logger: Logger
}

/** Service HTTP interne du gateway (appelé par l'API seulement). */
export function buildServer(options: ServerOptions) {
  const app = Fastify({ loggerInstance: options.logger, bodyLimit: BODY_LIMIT_BYTES })
  const { router } = options

  app.addHook('onRequest', async (request, reply) => {
    if (!sameSecret(request.headers[INTERNAL_TOKEN_HEADER], options.internalToken)) {
      await reply.code(401).send({ error: 'unauthorized' })
    }
  })

  app.setErrorHandler(async (error, _request, reply) => {
    if (error instanceof ZodError) {
      await reply.code(400).send({ error: 'invalid_request', issues: error.issues })
      return
    }
    if (error instanceof NoAgentAvailableError || error instanceof AgentUnreachableError) {
      await reply.code(503).send({ error: 'no_agent_available', message: error.message })
      return
    }
    if (error instanceof NoCompileOutputError) {
      await reply.code(404).send({ error: 'no_compile_output', message: error.message })
      return
    }
    if (error instanceof AgentResponseError && error.status < 500) {
      await reply.code(error.status).send(error.body)
      return
    }
    app.log.error(error)
    await reply.code(502).send({ error: 'agent_error' })
  })

  app.get('/health', async () => ({
    status: 'ok',
    agents: await Promise.all(
      [...options.pool.agents.keys()].map(async (agentId) => {
        const health = await options.pool.health(agentId)
        return { agentId, available: health !== null, ...(health ?? {}) }
      }),
    ),
  }))

  app.post('/compile', async (request) => router.compile(compileRequestSchema.parse(request.body)))

  app.post('/projects/:projectId/stop', async (request) => {
    const { projectId } = projectParamsSchema.parse(request.params)
    return stopCompileResponseSchema.parse({ stopped: await router.stop(projectId) })
  })

  app.post('/projects/:projectId/clear-cache', async (request) => {
    const { projectId } = projectParamsSchema.parse(request.params)
    return clearCacheResponseSchema.parse({ cleared: await router.clearCache(projectId) })
  })

  app.get('/projects/:projectId/synctex/code', async (request) => {
    const { projectId } = projectParamsSchema.parse(request.params)
    return router.synctexFromCode(projectId, synctexCodeQuerySchema.parse(request.query))
  })

  app.get('/projects/:projectId/synctex/pdf', async (request) => {
    const { projectId } = projectParamsSchema.parse(request.params)
    return router.synctexFromPdf(projectId, synctexPdfQuerySchema.parse(request.query))
  })

  return app
}
