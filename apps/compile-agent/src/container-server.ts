import { createReadStream } from 'node:fs'
import { rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { type Readable } from 'node:stream'
import { isSafeRelativePath, sha256Schema } from '@kaxolax/contracts'
import { type Logger } from 'pino'
import { z } from 'zod'
import { type Compiler, InvalidRequestError } from './compiler.js'
import { buildServer } from './server.js'
import { type BinaryCache, ChecksumMismatchError } from './storage.js'

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
/** Seules les sorties d'une compilation sont lisibles : PDF, log, blg et SyncTeX. */
const OUTPUT_KEY = new RegExp(
  `^outputs/(${UUID})/(${UUID})/(output\\.(?:pdf|log|blg|synctex\\.gz))$`,
)
const MAX_MISSING_QUERY = 10_000

const projectParamsSchema = z.object({ projectId: z.uuid() })
const buildParamsSchema = z.object({ projectId: z.uuid(), buildId: z.uuid() })
const missingBodySchema = z.object({ sha256: z.array(sha256Schema).max(MAX_MISSING_QUERY) })
const restoreQuerySchema = z.object({
  root: z.string().refine(isSafeRelativePath, { message: 'Invalid root resource path' }),
})

export interface ContainerServerOptions {
  compiler: Compiler
  cache: BinaryCache
  outputsDir: string
  outputBucket: string
  internalToken: string
  logger: Logger
}

/**
 * Serveur de l'agent dans le conteneur Cloudflare. Mêmes routes que l'agent de l'étape 1
 * (compilation, arrêt, cache, SyncTeX, comptage de mots, conversion Markdown → LaTeX), plus celles qui remplacent l'accès direct à S3 : le
 * Worker pousse les binaires manquants, relit les sorties, restaure le SyncTeX. Le conteneur
 * n'ouvre aucune connexion sortante.
 */
export function buildContainerServer(options: ContainerServerOptions) {
  const app = buildServer({
    compiler: options.compiler,
    internalToken: options.internalToken,
    logger: options.logger,
  })
  // Corps binaires transmis en flux, sans mise en mémoire (le jeton interne est vérifié avant).
  app.addContentTypeParser(
    ['application/octet-stream', 'application/gzip'],
    (_request, payload, done) => {
      done(null, payload)
    },
  )

  app.post('/blobs/missing', async (request) => {
    const { sha256 } = missingBodySchema.parse(request.body)
    const missing: string[] = []
    for (const hash of new Set(sha256)) {
      if (!(await options.cache.has(hash))) missing.push(hash)
    }
    return { missing }
  })

  app.put('/blobs/:sha256', async (request, reply) => {
    const hash = sha256Schema.parse((request.params as { sha256: string }).sha256)
    try {
      await options.cache.store(hash, request.body as Readable)
    } catch (error) {
      if (error instanceof ChecksumMismatchError) throw new InvalidRequestError(error.message)
      throw error
    }
    return reply.code(204).send()
  })

  app.get('/outputs/*', async (request, reply) => {
    const key = (request.params as { '*': string })['*']
    if (!OUTPUT_KEY.test(key)) return reply.code(404).send({ error: 'not_found' })
    const path = join(options.outputsDir, options.outputBucket, key)
    const info = await stat(path).catch(() => null)
    if (!info?.isFile()) return reply.code(404).send({ error: 'not_found' })
    return reply
      .header('content-type', 'application/octet-stream')
      .header('content-length', info.size)
      .send(createReadStream(path))
  })

  app.delete('/outputs/:projectId/:buildId', async (request, reply) => {
    const { projectId, buildId } = buildParamsSchema.parse(request.params)
    await rm(join(options.outputsDir, options.outputBucket, 'outputs', projectId, buildId), {
      recursive: true,
      force: true,
    })
    return reply.code(204).send()
  })

  app.get('/projects/:projectId/synctex/available', async (request) => {
    const { projectId } = projectParamsSchema.parse(request.params)
    return { available: await options.compiler.hasSynctex(projectId) }
  })

  app.put('/projects/:projectId/synctex', async (request, reply) => {
    const { projectId } = projectParamsSchema.parse(request.params)
    const { root } = restoreQuerySchema.parse(request.query)
    await options.compiler.restoreSynctex(projectId, root, request.body as Readable)
    return reply.code(204).send()
  })

  return app
}
