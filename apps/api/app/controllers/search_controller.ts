import { projectSearchQuerySchema } from '@kaxolax/contracts'
import { inject } from '@adonisjs/core'
import type { HttpContext } from '@adonisjs/core/http'
import { projectFor } from '#services/project_access'
import { projectContent } from '#services/project_content'
import { projectSearches } from '#services/project_search'
import RealtimeClient from '#services/realtime_client'
import { validateWithZod } from '#validators/zod'

@inject()
export default class SearchController {
  constructor(private readonly realtime: RealtimeClient) {}

  /**
   * Recherche dans tout le projet (permission `read`) : texte courant de chaque document, instantané du
   * service temps réel ou état enregistré. `q`, `caseSensitive`, `wholeWord`, `regex`. La
   * recherche tourne dans un worker ; une nouvelle recherche du même utilisateur remplace la
   * précédente (409 pour celle-ci), et 429 quand toutes les places du processus sont prises.
   */
  async search({ params, auth, request }: HttpContext) {
    const query = validateWithZod(projectSearchQuerySchema, request.qs())
    const user = auth.getUserOrFail()
    const { project } = await projectFor(user, String(params.id), 'read')
    return projectSearches.search(
      user.id,
      query,
      async () => (await projectContent(this.realtime, project.id)).documents,
    )
  }
}
