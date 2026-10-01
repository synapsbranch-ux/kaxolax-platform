import type { HttpContext } from '@adonisjs/core/http'
import { listWorkspaces } from '#services/workspace_service'

export default class WorkspacesController {
  /** Workspaces de l'utilisateur avec son rôle (sélecteur du dashboard et de la sidebar). */
  async index({ auth }: HttpContext) {
    return { workspaces: await listWorkspaces(auth.getUserOrFail()) }
  }
}
