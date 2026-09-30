import { MAX_TEXT_DOCUMENT_BYTES } from '@kaxolax/contracts'
import { Exception } from '@adonisjs/core/exceptions'
import type { HttpContext } from '@adonisjs/core/http'
import db from '@adonisjs/lucid/services/db'
import { type TransactionClientContract } from '@adonisjs/lucid/types/database'
import { DateTime } from 'luxon'
import Project from '#models/project'
import { projectFor } from '#services/project_access'
import {
  buildTree,
  createDocument,
  createFolder,
  deleteEntity,
  updateEntity,
} from '#services/tree_service'
import {
  createDocumentValidator,
  createFolderValidator,
  entityParamsValidator,
  updateEntityValidator,
} from '#validators/tree'

export class DocumentTooLargeException extends Exception {
  static override status = 422
  static override code = 'E_DOCUMENT_TOO_LARGE'
  static override message = 'A text document must be smaller than 2 MB'
}

/** Toute modification de l'arborescence met à jour la date du projet (tri du dashboard). */
async function touch(trx: TransactionClientContract, project: Project) {
  await Project.query({ client: trx })
    .where('id', project.id)
    .update({ updatedAt: DateTime.utc().toSQL() })
}

export default class TreeController {
  async show({ params, auth }: HttpContext) {
    const { project } = await projectFor(auth.getUserOrFail(), String(params.id), 'viewer')
    return { mainDocumentId: project.mainDocumentId, ...(await buildTree(project.id)) }
  }

  async storeFolder({ request, params, auth, response }: HttpContext) {
    const input = await request.validateUsing(createFolderValidator)
    const folder = await db.transaction(async (trx) => {
      const { project } = await projectFor(auth.getUserOrFail(), String(params.id), 'editor', {
        trx,
        lock: true,
      })
      const created = await createFolder(trx, project.id, {
        name: input.name,
        parentId: input.parentId ?? null,
      })
      await touch(trx, project)
      return created
    })
    response.created({
      folder: { id: folder.id, parentId: folder.parentId, name: folder.name },
    })
  }

  async storeDocument({ request, params, auth, response }: HttpContext) {
    const input = await request.validateUsing(createDocumentValidator)
    const content = input.content ?? ''
    if (Buffer.byteLength(content, 'utf8') >= MAX_TEXT_DOCUMENT_BYTES)
      throw new DocumentTooLargeException()
    const document = await db.transaction(async (trx) => {
      const { project } = await projectFor(auth.getUserOrFail(), String(params.id), 'editor', {
        trx,
        lock: true,
      })
      const created = await createDocument(trx, project.id, {
        name: input.name,
        folderId: input.folderId ?? null,
        content,
      })
      await touch(trx, project)
      return created
    })
    response.created({
      document: { id: document.id, folderId: document.folderId, name: document.name },
    })
  }

  async update({ request, params, auth }: HttpContext) {
    const { type } = await entityParamsValidator.validate(params)
    const changes = await request.validateUsing(updateEntityValidator)
    const entity = await db.transaction(async (trx) => {
      const { project } = await projectFor(auth.getUserOrFail(), String(params.id), 'editor', {
        trx,
        lock: true,
      })
      const updated = await updateEntity(trx, project.id, type, String(params.entityId), changes)
      await touch(trx, project)
      return updated
    })
    return { type, id: entity.id, name: entity.name }
  }

  async destroy({ params, auth, response }: HttpContext) {
    const { type } = await entityParamsValidator.validate(params)
    await db.transaction(async (trx) => {
      const { project } = await projectFor(auth.getUserOrFail(), String(params.id), 'editor', {
        trx,
        lock: true,
      })
      await deleteEntity(trx, project.id, type, String(params.entityId))
      await touch(trx, project)
    })
    response.noContent()
  }
}
