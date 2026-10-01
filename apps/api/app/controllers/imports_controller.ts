import { inject } from '@adonisjs/core'
import type { HttpContext } from '@adonisjs/core/http'
import ObjectStorage from '#services/object_storage'
import { serializeProject } from '#services/project_service'
import { completeImport, startImport } from '#services/upload_service'
import { completeImportValidator, createImportValidator } from '#validators/uploads'

@inject()
export default class ImportsController {
  constructor(private readonly storage: ObjectStorage) {}

  async store({ request, auth, response }: HttpContext) {
    const input = await request.validateUsing(createImportValidator)
    response.created(await startImport(this.storage, auth.getUserOrFail(), input))
  }

  /** Extrait le zip et renvoie le projet créé (workspace demandé, sinon personnel). */
  async complete({ request, params, auth, response }: HttpContext) {
    const { workspaceId } = await request.validateUsing(completeImportValidator)
    const project = await completeImport(
      this.storage,
      auth.getUserOrFail(),
      String(params.uploadId),
      workspaceId,
    )
    response.created({ project: serializeProject(project, 'owner') })
  }
}
