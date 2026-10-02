import { inject } from '@adonisjs/core'
import type { HttpContext } from '@adonisjs/core/http'
import { projectFor } from '#services/project_access'
import RealtimeClient from '#services/realtime_client'

@inject()
export default class RealtimeController {
  constructor(private readonly realtime: RealtimeClient) {}

  /** Tout membre obtient un jeton ; le service temps réel relit son rôle (lecture seule ou non). */
  async token({ params, auth }: HttpContext) {
    const user = auth.getUserOrFail()
    const { project, role } = await projectFor(user, String(params.id), 'read')
    return this.realtime.issueToken(user.id, project.id, role)
  }
}
