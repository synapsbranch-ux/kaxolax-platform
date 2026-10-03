import { moveProjectInputSchema, teamAccessInputSchema } from '@kaxolax/contracts'
import { inject } from '@adonisjs/core'
import type { HttpContext } from '@adonisjs/core/http'
import RealtimeClient from '#services/realtime_client'
import { moveProjectToTeam, notifyTeamAccess, setTeamAccess } from '#services/team_projects'
import { validateWithZod } from '#validators/zod'

/** Projets et workspaces d'équipe : déplacement vers une équipe, accès des membres de l'équipe. */
@inject()
export default class TeamProjectsController {
  constructor(private readonly realtime: RealtimeClient) {}

  /** `POST /projects/:id/move` : projet personnel déplacé vers une équipe (propriétaire). */
  async move({ auth, params, request }: HttpContext) {
    const input = validateWithZod(moveProjectInputSchema, request.body())
    const { project, notice } = await moveProjectToTeam(
      auth.getUserOrFail(),
      String(params.id),
      input.workspaceId,
    )
    await notifyTeamAccess(this.realtime, notice)
    return { project }
  }

  /** `PUT /projects/:id/team-access` : rôle des membres de l'équipe sur ce projet. */
  async updateTeamAccess({ auth, params, request }: HttpContext) {
    const input = validateWithZod(teamAccessInputSchema, request.body())
    const { access, notice } = await setTeamAccess(
      auth.getUserOrFail(),
      String(params.id),
      input.role,
    )
    await notifyTeamAccess(this.realtime, notice)
    return { access }
  }
}
