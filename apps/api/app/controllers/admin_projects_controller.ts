import { ADMIN_DEFAULT_PAGE_SIZE } from '@kaxolax/contracts'
import { inject } from '@adonisjs/core'
import type { HttpContext } from '@adonisjs/core/http'
import {
  changeProjectState,
  deleteProject,
  projectDetail,
  type ProjectStateAction,
  searchProjects,
  transferProject,
} from '#services/admin_projects'
import ObjectStorage from '#services/object_storage'
import RealtimeClient from '#services/realtime_client'
import { adminProjectsQueryValidator, transferProjectValidator } from '#validators/admin'

/** Admin : projets (recherche, métadonnées, transfert, états, suppression), sans leur contenu. */
@inject()
export default class AdminProjectsController {
  constructor(
    private readonly realtime: RealtimeClient,
    private readonly storage: ObjectStorage,
  ) {}

  async index({ request }: HttpContext) {
    const { q, view, page, perPage } = await request.validateUsing(adminProjectsQueryValidator, {
      data: request.qs(),
    })
    return searchProjects({
      q,
      view: view ?? 'all',
      page: page ?? 1,
      perPage: perPage ?? ADMIN_DEFAULT_PAGE_SIZE,
    })
  }

  async show({ params }: HttpContext) {
    return { project: await projectDetail(String(params.id)) }
  }

  async transfer({ params, request, auth }: HttpContext) {
    const { newOwnerId } = await request.validateUsing(transferProjectValidator)
    await transferProject(auth.getUserOrFail(), String(params.id), newOwnerId)
    return { project: await projectDetail(String(params.id)) }
  }

  private async changeState({ params, auth }: HttpContext, action: ProjectStateAction) {
    await changeProjectState(auth.getUserOrFail(), String(params.id), action)
    return { project: await projectDetail(String(params.id)) }
  }

  archive(ctx: HttpContext) {
    return this.changeState(ctx, 'project.archive')
  }

  unarchive(ctx: HttpContext) {
    return this.changeState(ctx, 'project.unarchive')
  }

  trash(ctx: HttpContext) {
    return this.changeState(ctx, 'project.trash')
  }

  restore(ctx: HttpContext) {
    return this.changeState(ctx, 'project.restore')
  }

  /** Suppression définitive, seulement depuis la corbeille. */
  async destroy({ params, auth, response }: HttpContext) {
    await deleteProject(auth.getUserOrFail(), String(params.id), {
      realtime: this.realtime,
      storage: this.storage,
    })
    response.noContent()
  }
}
