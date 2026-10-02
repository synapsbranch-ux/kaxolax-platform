import { MAX_TEXT_DOCUMENT_BYTES } from '@kaxolax/contracts'
import { inject } from '@adonisjs/core'
import { Exception } from '@adonisjs/core/exceptions'
import type { HttpContext } from '@adonisjs/core/http'
import db from '@adonisjs/lucid/services/db'
import { releaseFileObjects } from '#services/history_service'
import { projectFor } from '#services/project_access'
import ObjectStorage from '#services/object_storage'
import RealtimeClient from '#services/realtime_client'
import {
  buildTree,
  createDocument,
  createFolder,
  deleteEntity,
  parentOf,
  touchProject,
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

@inject()
export default class TreeController {
  constructor(
    private readonly realtime: RealtimeClient,
    private readonly storage: ObjectStorage,
  ) {}

  async show({ params, auth }: HttpContext) {
    const { project } = await projectFor(auth.getUserOrFail(), String(params.id), 'read')
    return { mainDocumentId: project.mainDocumentId, ...(await buildTree(project.id)) }
  }

  /**
   * Les modifications de l'arborescence sont diffusées aux clients connectés au projet (document
   * meta), après la validation de la transaction et au mieux.
   */
  async storeFolder({ request, params, auth, response }: HttpContext) {
    const input = await request.validateUsing(createFolderValidator)
    const user = auth.getUserOrFail()
    const folder = await db.transaction(async (trx) => {
      const { project } = await projectFor(user, String(params.id), 'edit', {
        trx,
        lock: true,
      })
      const created = await createFolder(trx, project.id, {
        name: input.name,
        parentId: input.parentId ?? null,
      })
      await touchProject(trx, project.id)
      return created
    })
    await this.realtime.publishProjectEvent(folder.projectId, {
      type: 'tree.changed',
      reason: 'create',
      actorId: user.id,
      changes: [
        {
          action: 'created',
          entity: 'folder',
          id: folder.id,
          parentId: folder.parentId,
          name: folder.name,
        },
      ],
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
    const user = auth.getUserOrFail()
    const document = await db.transaction(async (trx) => {
      const { project } = await projectFor(user, String(params.id), 'edit', {
        trx,
        lock: true,
      })
      const created = await createDocument(trx, project.id, {
        name: input.name,
        folderId: input.folderId ?? null,
        content,
        authorId: user.id,
      })
      await touchProject(trx, project.id)
      return created
    })
    await this.realtime.publishProjectEvent(document.projectId, {
      type: 'tree.changed',
      reason: 'create',
      actorId: user.id,
      changes: [
        {
          action: 'created',
          entity: 'document',
          id: document.id,
          parentId: document.folderId,
          name: document.name,
        },
      ],
    })
    response.created({
      document: { id: document.id, folderId: document.folderId, name: document.name },
    })
  }

  async update({ request, params, auth }: HttpContext) {
    const { type } = await entityParamsValidator.validate(params)
    const changes = await request.validateUsing(updateEntityValidator)
    const user = auth.getUserOrFail()
    const entity = await db.transaction(async (trx) => {
      const { project } = await projectFor(user, String(params.id), 'edit', {
        trx,
        lock: true,
      })
      const updated = await updateEntity(trx, project.id, type, String(params.entityId), changes)
      await touchProject(trx, project.id)
      return updated
    })
    await this.realtime.publishProjectEvent(entity.projectId, {
      type: 'tree.changed',
      reason: changes.folderId === undefined ? 'rename' : 'move',
      actorId: user.id,
      changes: [
        {
          action: 'updated',
          entity: type,
          id: entity.id,
          parentId: parentOf(entity),
          name: entity.name,
        },
      ],
    })
    return { type, id: entity.id, name: entity.name }
  }

  async destroy({ params, auth, response }: HttpContext) {
    const { type } = await entityParamsValidator.validate(params)
    const user = auth.getUserOrFail()
    const entityId = String(params.entityId)
    const deleted = await db.transaction(async (trx) => {
      const { project } = await projectFor(user, String(params.id), 'edit', {
        trx,
        lock: true,
      })
      const removed = await deleteEntity(trx, project.id, type, entityId)
      await touchProject(trx, project.id)
      return { ...removed, projectId: project.id }
    })
    // Après la validation de la transaction : les onglets ouverts sur ces documents sont fermés.
    await this.realtime.closeDocuments(deleted.documentIds)
    await this.realtime.publishProjectEvent(deleted.projectId, {
      type: 'tree.changed',
      reason: 'delete',
      actorId: user.id,
      changes: [{ action: 'deleted', entity: type, id: entityId }],
    })
    // Un binaire qu'une version référence encore reste dans le stockage (historique).
    await releaseFileObjects(this.storage, deleted.projectId, deleted.files)
    response.noContent()
  }
}
