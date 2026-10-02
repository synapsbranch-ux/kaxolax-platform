import { inject } from '@adonisjs/core'
import type { HttpContext } from '@adonisjs/core/http'
import ObjectStorage from '#services/object_storage'
import RealtimeClient from '#services/realtime_client'
import { serializeProject } from '#services/project_service'
import { completeImport, startImport } from '#services/upload_service'
import { completeImportValidator, createImportValidator } from '#validators/uploads'

@inject()
export default class ImportsController {
  constructor(
    private readonly storage: ObjectStorage,
    private readonly realtime: RealtimeClient,
  ) {}

  async store({ request, auth, response }: HttpContext) {
    const input = await request.validateUsing(createImportValidator)
    response.created(await startImport(this.storage, auth.getUserOrFail(), input))
  }

  /** Extrait le zip et renvoie le projet créé (workspace demandé, sinon personnel). */
  async complete({ request, params, auth, response }: HttpContext) {
    const { workspaceId } = await request.validateUsing(completeImportValidator)
    const user = auth.getUserOrFail()
    const project = await completeImport(this.storage, user, String(params.uploadId), workspaceId)
    // Projet neuf : personne n'y est encore connecté, mais la règle reste la même pour toute
    // écriture de l'arborescence (liste vide : relire toute l'arborescence).
    await this.realtime.publishProjectEvent(project.id, {
      type: 'tree.changed',
      reason: 'import',
      actorId: user.id,
      changes: [],
      mainDocumentId: project.mainDocumentId,
    })
    response.created({ project: serializeProject(project, 'owner') })
  }
}
