import { PassThrough, Readable } from 'node:stream'
import { inject } from '@adonisjs/core'
import type { HttpContext } from '@adonisjs/core/http'
import logger from '@adonisjs/core/services/logger'
import yazl from 'yazl'
import ObjectStorage, { contentDisposition } from '#services/object_storage'
import { projectFor } from '#services/project_access'
import { projectContent } from '#services/project_content'
import RealtimeClient from '#services/realtime_client'

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
    const { project } = await projectFor(auth.getUserOrFail(), String(params.id), 'viewer')
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
