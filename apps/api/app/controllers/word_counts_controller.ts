import { wordCountBodySchema } from '@kaxolax/contracts'
import { inject } from '@adonisjs/core'
import type { HttpContext } from '@adonisjs/core/http'
import CompileGateway from '#services/compile_gateway'
import CompileWorkerClient from '#services/compile_worker'
import { projectFor } from '#services/project_access'
import RealtimeClient from '#services/realtime_client'
import { countWords } from '#services/word_count_service'
import { validateWithZod } from '#validators/zod'

@inject()
export default class WordCountsController {
  constructor(
    private readonly gateway: CompileGateway,
    private readonly worker: CompileWorkerClient,
    private readonly realtime: RealtimeClient,
  ) {}

  /**
   * `POST /projects/:id/word-count` (permission `compile`, lecteurs compris : le comptage ne
   * modifie rien). Corps
   * facultatif `{ documentId }` pour compter un autre document que le principal. Réponse :
   * totaux, détail par section, avertissements de texcount (voir `wordCountResponseSchema`).
   * 422 `E_NO_MAIN_DOCUMENT` ou `E_WORD_COUNT_FAILED`, 429 `E_WORD_COUNT_BUSY` (un comptage
   * d'un autre document du projet, ou trop de comptages de l'utilisateur, en cours), 503
   * `E_COMPILE_UNAVAILABLE` (dont file d'attente de l'agent pleine).
   */
  async count({ params, auth, request }: HttpContext) {
    const user = auth.getUserOrFail()
    const { project } = await projectFor(user, String(params.id), 'compile')
    const body = validateWithZod(wordCountBodySchema, request.body())
    return countWords(
      { gateway: this.gateway, worker: this.worker, realtime: this.realtime },
      user,
      project,
      body.documentId,
    )
  }
}
