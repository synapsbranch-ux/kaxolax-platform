import { PassThrough, Readable } from 'node:stream'
import { inject } from '@adonisjs/core'
import { Exception } from '@adonisjs/core/exceptions'
import type { HttpContext } from '@adonisjs/core/http'
import encryption from '@adonisjs/core/services/encryption'
import logger from '@adonisjs/core/services/logger'
import yazl from 'yazl'
import User from '#models/user'
import ObjectStorage, { contentDisposition } from '#services/object_storage'
import { projectFor } from '#services/project_access'
import { projectContent } from '#services/project_content'
import RealtimeClient from '#services/realtime_client'

/** Lien de téléchargement chiffré par APP_KEY, lié à l'utilisateur et au projet. */
const DOWNLOAD_PURPOSE = 'project-download'
const DOWNLOAD_TTL_SECONDS = 60

export class DownloadLinkExpiredException extends Exception {
  static override status = 410
  static override code = 'E_DOWNLOAD_LINK_EXPIRED'
  static override message = 'This download link has expired'
}

@inject()
export default class ExportsController {
  constructor(
    private readonly realtime: RealtimeClient,
    private readonly storage: ObjectStorage,
  ) {}

  /**
   * Zip du projet en streaming : texte courant des documents, binaires lus dans S3 un par un au
   * moment de les écrire, dossiers vides compris. Réimportable tel quel.
   */
  async download({ params, auth, response }: HttpContext) {
    await this.stream(auth.getUserOrFail(), String(params.id), response)
  }

  /**
   * Lien court (60 s) pour télécharger le zip par une simple navigation : le jeton Clerk voyage dans
   * un en-tête, qu'un lien <a> ne peut pas porter.
   */
  async downloadUrl({ params, auth }: HttpContext) {
    const user = auth.getUserOrFail()
    const { project } = await projectFor(user, String(params.id), 'viewer')
    const token = encryption.encrypt(
      { userId: user.id, projectId: project.id },
      `${String(DOWNLOAD_TTL_SECONDS)}s`,
      DOWNLOAD_PURPOSE,
    )
    return {
      url: `/api/v1/downloads/${encodeURIComponent(token)}`,
      expiresAt: new Date(Date.now() + DOWNLOAD_TTL_SECONDS * 1000).toISOString(),
    }
  }

  /** Téléchargement par lien : le rôle est revérifié au moment du téléchargement. */
  async downloadWithLink({ params, response }: HttpContext) {
    const claims = encryption.decrypt<{ userId?: unknown; projectId?: unknown }>(
      String(params.token),
      DOWNLOAD_PURPOSE,
    )
    if (typeof claims?.userId !== 'string' || typeof claims.projectId !== 'string') {
      throw new DownloadLinkExpiredException()
    }
    const user = await User.query().where('id', claims.userId).whereNull('deletedAt').first()
    if (!user) throw new DownloadLinkExpiredException()
    await this.stream(user, claims.projectId, response)
  }

  private async stream(user: User, projectId: string, response: HttpContext['response']) {
    const { project } = await projectFor(user, projectId, 'viewer')
    const content = await projectContent(this.realtime, project.id)

    const zip = new yazl.ZipFile()
    const occupied = new Set([
      ...content.documents.map((document) => document.path),
      ...content.files.map((file) => file.path),
    ])
    for (const folder of content.folders) {
      const hasChildren = [...occupied].some((path) => path.startsWith(`${folder}/`))
      if (!hasChildren) zip.addEmptyDirectory(folder)
    }
    for (const document of content.documents) {
      zip.addBuffer(Buffer.from(document.content, 'utf8'), document.path)
    }
    for (const file of content.files) {
      zip.addReadStreamLazy(file.path, { size: file.sizeBytes, compress: false }, (callback) => {
        this.storage.read(file.s3Key).then(
          (stream) => {
            callback(null, stream)
          },
          (error: unknown) => {
            callback(error instanceof Error ? error : new Error(String(error)), Readable.from([]))
          },
        )
      })
    }
    zip.end()
    const output = new PassThrough()
    zip.outputStream.pipe(output)
    // Un binaire illisible en cours de route : la réponse est coupée (zip incomplet, jamais tronqué en silence).
    zip.on('error', (error: Error) => {
      logger.error({ err: error, projectId: project.id }, 'zip export failed')
      output.destroy(error)
    })

    response.header('content-type', 'application/zip')
    response.header('content-disposition', contentDisposition('attachment', `${project.name}.zip`))
    response.header('cache-control', 'no-store')
    response.stream(output)
  }
}
