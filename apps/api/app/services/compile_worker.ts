import {
  clearCacheResponseSchema,
  signCompileWorkerToken,
  type SynctexCodeResponse,
  synctexCodeResponseSchema,
  type SynctexPdfResponse,
  synctexPdfResponseSchema,
  type WorkerCompileJob,
  type WorkerEnqueueResponse,
  workerEnqueueResponseSchema,
  type WorkerSynctexCodeQuery,
  type WorkerSynctexPdfQuery,
} from '@kaxolax/contracts'
import compileConfig from '#config/compile'
import {
  CompileServiceUnavailableException,
  NoCompileOutputException,
} from '#services/compile_gateway'

/**
 * Appels de l'API au Worker de compilation Cloudflare (mode `cloudflare`). Chaque appel porte un
 * jeton HMAC de 60 secondes lié au projet. Remplacé par un faux dans les tests.
 */
export default class CompileWorkerClient {
  private async call(
    projectId: string,
    path: string,
    init: { method: 'GET' | 'POST'; body?: unknown },
  ): Promise<unknown> {
    const secret = compileConfig.workerSecret
    if (secret === undefined) throw new CompileServiceUnavailableException()
    let response: Response
    try {
      response = await fetch(`${compileConfig.workerUrl}/projects/${projectId}${path}`, {
        method: init.method,
        headers: {
          authorization: `Bearer ${await signCompileWorkerToken(projectId, secret.release())}`,
          ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
        signal: AbortSignal.timeout(compileConfig.workerCallTimeoutMs),
      })
    } catch (error) {
      throw new CompileServiceUnavailableException(undefined, { cause: error })
    }
    if (response.status === 404) throw new NoCompileOutputException()
    if (!response.ok) {
      throw new CompileServiceUnavailableException(
        `compile worker answered ${String(response.status)}`,
      )
    }
    return response.json()
  }

  /** Met la compilation en file dans le Durable Object du projet (réponse immédiate). */
  async enqueue(job: WorkerCompileJob): Promise<WorkerEnqueueResponse> {
    return workerEnqueueResponseSchema.parse(
      await this.call(job.projectId, '/compile', { method: 'POST', body: job }),
    )
  }

  async cancel(projectId: string, buildId: string): Promise<void> {
    await this.call(projectId, '/cancel', { method: 'POST', body: { buildId } })
  }

  /** Réveil anticipé du conteneur du projet (ouverture de l'éditeur). */
  async warm(projectId: string): Promise<void> {
    await this.call(projectId, '/warm', { method: 'POST' })
  }

  async clearCache(projectId: string): Promise<boolean> {
    const body = await this.call(projectId, '/clear-cache', { method: 'POST' })
    return clearCacheResponseSchema.parse(body).cleared
  }

  async synctexFromCode(
    projectId: string,
    query: WorkerSynctexCodeQuery,
  ): Promise<SynctexCodeResponse> {
    const params = new URLSearchParams({
      file: query.file,
      line: String(query.line),
      column: String(query.column),
      buildId: query.buildId,
    })
    const body = await this.call(projectId, `/synctex/code?${params.toString()}`, {
      method: 'GET',
    })
    return synctexCodeResponseSchema.parse(body)
  }

  async synctexFromPdf(
    projectId: string,
    query: WorkerSynctexPdfQuery,
  ): Promise<SynctexPdfResponse> {
    const params = new URLSearchParams({
      page: String(query.page),
      h: String(query.h),
      v: String(query.v),
      buildId: query.buildId,
    })
    const body = await this.call(projectId, `/synctex/pdf?${params.toString()}`, { method: 'GET' })
    return synctexPdfResponseSchema.parse(body)
  }
}
