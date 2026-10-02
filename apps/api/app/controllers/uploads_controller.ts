import { inject } from '@adonisjs/core'
import type { HttpContext } from '@adonisjs/core/http'
import ObjectStorage from '#services/object_storage'
import RealtimeClient from '#services/realtime_client'
import { completeFileUpload, startFileUpload } from '#services/upload_service'
import { createUploadValidator } from '#validators/uploads'

@inject()
export default class UploadsController {
  constructor(
    private readonly storage: ObjectStorage,
    private readonly realtime: RealtimeClient,
  ) {}

  /** Crée un upload en attente et renvoie l'URL présignée où envoyer le fichier. */
  async store({ request, params, auth, response }: HttpContext) {
    const input = await request.validateUsing(createUploadValidator)
    const started = await startFileUpload(this.storage, auth.getUserOrFail(), String(params.id), {
      filename: input.filename,
      folderId: input.folderId ?? null,
      sizeBytes: input.sizeBytes,
    })
    response.created(started)
  }

  async complete({ params, auth, response }: HttpContext) {
    const user = auth.getUserOrFail()
    const completed = await completeFileUpload(
      this.storage,
      user,
      String(params.id),
      String(params.uploadId),
    )
    const { entity } = completed
    // Diffusé aux clients connectés au projet, une fois l'upload enregistré.
    await this.realtime.publishProjectEvent(entity.projectId, {
      type: 'tree.changed',
      reason: 'upload',
      actorId: user.id,
      changes: [
        {
          action: 'created',
          entity: completed.type,
          id: entity.id,
          parentId: entity.folderId,
          name: entity.name,
        },
      ],
    })
    response.created(
      completed.type === 'document'
        ? {
            type: 'document',
            document: { id: entity.id, folderId: entity.folderId, name: entity.name },
          }
        : {
            type: 'file',
            file: {
              id: completed.entity.id,
              folderId: completed.entity.folderId,
              name: completed.entity.name,
              sizeBytes: completed.entity.sizeBytes,
              mimeType: completed.entity.mimeType,
            },
          },
    )
  }
}
