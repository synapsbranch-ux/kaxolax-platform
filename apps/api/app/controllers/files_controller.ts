import { inject } from '@adonisjs/core'
import type { HttpContext } from '@adonisjs/core/http'
import { DateTime } from 'luxon'
import storageConfig from '#config/storage'
import File from '#models/file'
import ObjectStorage from '#services/object_storage'
import { isUuid, projectFor } from '#services/project_access'
import { EntityNotFoundException } from '#services/tree_service'
import { fileUrlValidator } from '#validators/uploads'

@inject()
export default class FilesController {
  constructor(private readonly storage: ObjectStorage) {}

  /** URL présignée de courte durée pour afficher ou télécharger un fichier binaire. */
  async url({ params, request, auth }: HttpContext) {
    const { download } = await request.validateUsing(fileUrlValidator, { data: request.qs() })
    const { project } = await projectFor(auth.getUserOrFail(), String(params.id), 'read')
    const fileId = String(params.fileId)
    const file = isUuid(fileId)
      ? await File.query().where({ id: fileId, projectId: project.id }).first()
      : null
    if (!file) throw new EntityNotFoundException('File not found')
    return {
      url: await this.storage.presignDownload(file.s3Key, file.name, {
        mode: download === true ? 'attachment' : 'inline',
        contentType: file.mimeType,
      }),
      expiresAt: DateTime.utc().plus({ seconds: storageConfig.downloadUrlTtlSeconds }).toISO(),
    }
  }
}
