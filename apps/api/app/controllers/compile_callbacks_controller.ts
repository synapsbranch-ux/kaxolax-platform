import {
  CALLBACK_SIGNATURE_HEADER,
  CALLBACK_TIMESTAMP_HEADER,
  verifyCallback,
  type WorkerCallbackResponse,
  workerCallbackSchema,
} from '@kaxolax/contracts'
import { inject } from '@adonisjs/core'
import type { HttpContext } from '@adonisjs/core/http'
import logger from '@adonisjs/core/services/logger'
import compileConfig from '#config/compile'
import { applyWorkerCallback } from '#services/async_compile_service'
import { CompileOutputStorage } from '#services/object_storage'
import ProjectEvents from '#services/project_events'

/**
 * Rappels du Worker de compilation (route interne, hors session) : HMAC du corps brut avec
 * `COMPILE_WORKER_SECRET`, horodatage à moins de 5 minutes, puis application idempotente.
 */
@inject()
export default class CompileCallbacksController {
  constructor(
    private readonly outputs: CompileOutputStorage,
    private readonly events: ProjectEvents,
  ) {}

  async handle({ request, response }: HttpContext): Promise<WorkerCallbackResponse | undefined> {
    const secret = compileConfig.workerSecret
    if (compileConfig.backend !== 'cloudflare' || secret === undefined) {
      response.notFound({ code: 'E_NOT_FOUND' })
      return
    }
    const body = request.raw() ?? ''
    const signed = await verifyCallback(
      body,
      {
        timestamp: request.header(CALLBACK_TIMESTAMP_HEADER),
        signature: request.header(CALLBACK_SIGNATURE_HEADER),
      },
      secret.release(),
    )
    if (!signed) {
      logger.warn('compile callback refused: bad signature or timestamp')
      response.unauthorized({ code: 'E_INVALID_SIGNATURE', message: 'Invalid signature' })
      return
    }
    let json: unknown = null
    try {
      json = JSON.parse(body)
    } catch {
      // Corps signé mais illisible : refusé ci-dessous.
    }
    const parsed = workerCallbackSchema.safeParse(json)
    if (!parsed.success) {
      response.badRequest({ code: 'E_INVALID_CALLBACK', message: 'Invalid callback body' })
      return
    }
    const { applied, found } = await applyWorkerCallback(
      { outputs: this.outputs, events: this.events },
      parsed.data,
    )
    if (!found) {
      response.notFound({ code: 'E_BUILD_NOT_FOUND', message: 'Build not found' })
      return
    }
    return { applied }
  }
}
