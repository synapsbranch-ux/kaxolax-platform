import { inject } from '@adonisjs/core'
import { Exception } from '@adonisjs/core/exceptions'
import type { HttpContext } from '@adonisjs/core/http'
import { DateTime } from 'luxon'
import Document from '#models/document'
import { projectFor } from '#services/project_access'
import ObjectStorage, { projectPrefix } from '#services/object_storage'
import RealtimeClient from '#services/realtime_client'
import { createProject, listProjects, serializeProject } from '#services/project_service'
import {
  createProjectValidator,
  listProjectsValidator,
  updateProjectValidator,
} from '#validators/projects'

export class ProjectNotTrashedException extends Exception {
  static override status = 409
  static override code = 'E_PROJECT_NOT_TRASHED'
  static override message = 'Move the project to the trash before deleting it'
}

export class InvalidMainDocumentException extends Exception {
  static override status = 422
  static override code = 'E_INVALID_MAIN_DOCUMENT'
  static override message = 'The main document must be a document of this project'
}

@inject()
export default class ProjectsController {
  constructor(
    private readonly realtime: RealtimeClient,
    private readonly storage: ObjectStorage,
  ) {}

  async index({ request, auth }: HttpContext) {
    const { view, q } = await request.validateUsing(listProjectsValidator, { data: request.qs() })
    return { projects: await listProjects(auth.getUserOrFail(), view ?? 'active', q) }
  }

  async store({ request, response, auth }: HttpContext) {
    const { name } = await request.validateUsing(createProjectValidator)
    const user = auth.getUserOrFail()
    const project = await createProject(user, name)
    response.created({ project: serializeProject(project, 'owner') })
  }

  async update({ request, params, auth }: HttpContext) {
    const changes = await request.validateUsing(updateProjectValidator)
    const user = auth.getUserOrFail()
    // Renommer est réservé au propriétaire ; compilateur et document principal aux éditeurs.
    const { project, role } = await projectFor(
      user,
      String(params.id),
      changes.name === undefined ? 'editor' : 'owner',
    )
    if (changes.mainDocumentId !== undefined) {
      const document = await Document.query()
        .where({ id: changes.mainDocumentId, projectId: project.id })
        .first()
      if (!document) throw new InvalidMainDocumentException()
      project.mainDocumentId = document.id
    }
    if (changes.name !== undefined) project.name = changes.name
    if (changes.compiler !== undefined) project.compiler = changes.compiler
    await project.save()
    return { project: serializeProject(project, role) }
  }

  private async setState(
    { params, auth }: HttpContext,
    change: 'archivedAt' | 'trashedAt',
    value: DateTime | null,
  ) {
    const { project, role } = await projectFor(auth.getUserOrFail(), String(params.id), 'owner')
    project[change] = value
    await project.save()
    return { project: serializeProject(project, role) }
  }

  archive(ctx: HttpContext) {
    return this.setState(ctx, 'archivedAt', DateTime.utc())
  }

  unarchive(ctx: HttpContext) {
    return this.setState(ctx, 'archivedAt', null)
  }

  trash(ctx: HttpContext) {
    return this.setState(ctx, 'trashedAt', DateTime.utc())
  }

  restore(ctx: HttpContext) {
    return this.setState(ctx, 'trashedAt', null)
  }

  /** Suppression définitive, seulement depuis la corbeille. */
  async destroy({ params, auth, response }: HttpContext) {
    const { project } = await projectFor(auth.getUserOrFail(), String(params.id), 'owner')
    if (project.trashedAt === null) throw new ProjectNotTrashedException()
    const documents = await Document.query().where('projectId', project.id).select('id')
    await project.delete()
    await this.realtime.closeDocuments(documents.map((document) => document.id))
    await this.storage.deletePrefix(projectPrefix(project.id))
    response.noContent()
  }
}
