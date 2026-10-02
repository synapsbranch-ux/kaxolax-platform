import { randomUUID } from 'node:crypto'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDocumentState } from '@kaxolax/collab'
import {
  DEFAULT_SPELLCHECK_LANGUAGE,
  isValidEntityName,
  MAX_IMPORT_ZIP_BYTES,
  MAX_UPLOAD_BYTES,
} from '@kaxolax/contracts'
import { processUpload, UploadRejectedError } from '@kaxolax/upload-processor'
import { type ImportResult, importZip, ZipImportError } from '@kaxolax/zip-importer'
import { Exception } from '@adonisjs/core/exceptions'
import logger from '@adonisjs/core/services/logger'
import db from '@adonisjs/lucid/services/db'
import { type TransactionClientContract } from '@adonisjs/lucid/types/database'
import { DateTime } from 'luxon'
import storageConfig from '#config/storage'
import type Document from '#models/document'
import type File from '#models/file'
import Project from '#models/project'
import ProjectMember from '#models/project_member'
import Upload from '#models/upload'
import type User from '#models/user'
import type ObjectStorage from '#services/object_storage'
import { fileKey, projectPrefix, uploadKey } from '#services/object_storage'
import { projectFor } from '#services/project_access'
import {
  assertFolder,
  assertNameAvailable,
  createDocument,
  createFile,
  recordInitialStates,
  touchProject,
} from '#services/tree_service'
import { workspaceFor, workspaceForNewProject } from '#services/workspace_service'

export class UploadNotFoundException extends Exception {
  static override status = 404
  static override code = 'E_UPLOAD_NOT_FOUND'
  static override message = 'Upload not found'
}

export class UploadNotPendingException extends Exception {
  static override status = 409
  static override code = 'E_UPLOAD_NOT_PENDING'
  static override message = 'This upload was already completed or has failed'
}

export class UploadExpiredException extends Exception {
  static override status = 410
  static override code = 'E_UPLOAD_EXPIRED'
  static override message = 'This upload has expired, start a new one'
}

/** Refus d'un upload (objet absent, taille) ou d'un zip (chemin, bombe…) : 422 avec son code. */
export class UploadInvalidException extends Exception {
  static override status = 422
}

export interface StartedUpload {
  uploadId: string
  /** URL de PUT présignée : le corps doit faire exactement `sizeBytes` octets. */
  url: string
  method: 'PUT'
  expiresAt: string
}

async function startUpload(
  storage: ObjectStorage,
  fields: Pick<Upload, 'projectId' | 'userId' | 'purpose' | 'filename' | 'folderId' | 'sizeBytes'>,
): Promise<StartedUpload> {
  const id = randomUUID()
  const upload = await Upload.create({
    id,
    ...fields,
    s3Key: uploadKey(id),
    status: 'pending',
    expiresAt: DateTime.utc().plus({ seconds: storageConfig.uploadTtlSeconds }),
  })
  return {
    uploadId: upload.id,
    url: await storage.presignUpload(upload.s3Key, upload.sizeBytes),
    method: 'PUT',
    expiresAt: DateTime.utc().plus({ seconds: storageConfig.uploadUrlTtlSeconds }).toISO(),
  }
}

/** Charge un upload en attente de l'utilisateur, verrouillé dans la transaction `trx`. */
async function pendingUpload(
  query: { id: string; userId: string; purpose: 'file' | 'import'; projectId?: string },
  trx?: TransactionClientContract,
): Promise<Upload> {
  if (!/^[0-9a-f-]{36}$/i.test(query.id)) throw new UploadNotFoundException()
  const builder = Upload.query({ client: trx }).where({
    id: query.id,
    userId: query.userId,
    purpose: query.purpose,
  })
  if (query.projectId !== undefined) void builder.where('projectId', query.projectId)
  if (trx) void builder.forUpdate()
  const upload = await builder.first()
  if (!upload) throw new UploadNotFoundException()
  if (upload.status !== 'pending') throw new UploadNotPendingException()
  if (upload.expiresAt < DateTime.utc()) throw new UploadExpiredException()
  return upload
}

async function markFailed(storage: ObjectStorage, upload: Upload): Promise<void> {
  await Upload.query().where('id', upload.id).update({ status: 'failed' })
  await storage.delete([upload.s3Key])
}

export async function startFileUpload(
  storage: ObjectStorage,
  user: User,
  projectId: string,
  input: { filename: string; folderId: string | null; sizeBytes: number },
): Promise<StartedUpload> {
  const { project } = await projectFor(user, projectId, 'edit')
  // Vérification anticipée (refaite à la complétion) : pas d'upload pour un nom déjà pris.
  await db.transaction(async (trx) => {
    await assertFolder(trx, project.id, input.folderId)
    await assertNameAvailable(trx, project.id, input.folderId, input.filename)
  })
  return startUpload(storage, {
    projectId: project.id,
    userId: user.id,
    purpose: 'file',
    filename: input.filename,
    folderId: input.folderId,
    sizeBytes: input.sizeBytes,
  })
}

export type CompletedUpload =
  { type: 'document'; entity: Document } | { type: 'file'; entity: File }

/**
 * Termine un upload : vérification de l'objet et de sa taille, sha256, puis document texte (objet
 * supprimé) ou fichier binaire (objet déplacé sous `projects/{id}/files/`).
 */
export async function completeFileUpload(
  storage: ObjectStorage,
  user: User,
  projectId: string,
  uploadId: string,
): Promise<CompletedUpload> {
  const { project } = await projectFor(user, projectId, 'edit')
  const upload = await pendingUpload({
    id: uploadId,
    userId: user.id,
    purpose: 'file',
    projectId: project.id,
  })

  let processed
  try {
    processed = await processUpload(
      {
        key: upload.s3Key,
        filename: upload.filename,
        declaredSizeBytes: upload.sizeBytes,
        maxSizeBytes: MAX_UPLOAD_BYTES,
      },
      storage,
    )
  } catch (error) {
    if (!(error instanceof UploadRejectedError)) throw error
    await markFailed(storage, upload)
    throw new UploadInvalidException(error.message, { code: error.code })
  }

  const fileId = randomUUID()
  const key = fileKey(project.id, fileId)
  if (processed.kind === 'binary') await storage.copy(upload.s3Key, key, processed.mimeType)

  let completed: CompletedUpload
  try {
    completed = await db.transaction(async (trx) => {
      await projectFor(user, project.id, 'edit', { trx, lock: true })
      const locked = await pendingUpload(
        { id: upload.id, userId: user.id, purpose: 'file', projectId: project.id },
        trx,
      )
      const result: CompletedUpload =
        processed.kind === 'text'
          ? {
              type: 'document',
              entity: await createDocument(trx, project.id, {
                name: locked.filename,
                folderId: locked.folderId,
                content: processed.content,
                authorId: user.id,
              }),
            }
          : {
              type: 'file',
              entity: await createFile(trx, project.id, {
                id: fileId,
                name: locked.filename,
                folderId: locked.folderId,
                s3Key: key,
                sha256: processed.sha256,
                sizeBytes: processed.sizeBytes,
                mimeType: processed.mimeType,
              }),
            }
      locked.status = 'completed'
      await locked.useTransaction(trx).save()
      await touchProject(trx, project.id)
      return result
    })
  } catch (error) {
    if (processed.kind === 'binary') await storage.delete([key])
    throw error
  }
  await storage.delete([upload.s3Key])
  return completed
}

export async function startImport(
  storage: ObjectStorage,
  user: User,
  input: { filename: string; sizeBytes: number },
): Promise<StartedUpload> {
  return startUpload(storage, {
    projectId: null,
    userId: user.id,
    purpose: 'import',
    filename: input.filename,
    folderId: null,
    sizeBytes: input.sizeBytes,
  })
}

/** Nom du projet importé : celui du zip, sans l'extension. */
function projectNameFrom(filename: string): string {
  const name = filename.replace(/\.zip$/i, '').trim()
  return name !== '' && isValidEntityName(name) ? name : 'Imported project'
}

interface StoredBinary {
  fileId: string
  key: string
}

/** Insertions par lots : un import peut compter 5 000 fichiers. */
async function insertRows(
  trx: TransactionClientContract,
  table: string,
  rows: Record<string, unknown>[],
): Promise<void> {
  for (let index = 0; index < rows.length; index += 500) {
    await trx
      .insertQuery()
      .table(table)
      .multiInsert(rows.slice(index, index + 500))
  }
}

/** Crée dossiers, documents et fichiers d'un import ; renvoie l'identifiant de chaque document. */
async function insertTree(
  trx: TransactionClientContract,
  projectId: string,
  plan: ImportResult<StoredBinary>,
  authorId: string,
): Promise<Map<string, string>> {
  const folderIds = new Map<string, string>()
  const split = (path: string) => {
    const slash = path.lastIndexOf('/')
    return {
      folderId: slash === -1 ? null : (folderIds.get(path.slice(0, slash)) ?? null),
      name: path.slice(slash + 1),
    }
  }
  // Les dossiers arrivent parents d'abord : le parent a toujours déjà son identifiant.
  const folders = plan.folders.map((path) => {
    const { folderId, name } = split(path)
    const id = randomUUID()
    folderIds.set(path, id)
    return { id, project_id: projectId, parent_id: folderId, name }
  })
  await insertRows(trx, 'folders', folders)

  const documentIds = new Map<string, string>()
  const documents = plan.documents.map((document) => {
    const { folderId, name } = split(document.path)
    const id = randomUUID()
    documentIds.set(document.path, id)
    return {
      id,
      project_id: projectId,
      folder_id: folderId,
      name,
      yjs_state: Buffer.from(createDocumentState(document.content)),
      content_sha256: document.sha256,
    }
  })
  await insertRows(trx, 'documents', documents)
  // Historique : le contenu importé est attribué à la personne qui importe.
  await recordInitialStates(
    trx,
    documents.map((document) => ({
      projectId,
      documentId: document.id,
      userId: authorId,
      state: document.yjs_state,
    })),
  )
  await insertRows(
    trx,
    'files',
    plan.binaries.map((binary) => {
      const { folderId, name } = split(binary.path)
      return {
        id: binary.stored.fileId,
        project_id: projectId,
        folder_id: folderId,
        name,
        s3_key: binary.stored.key,
        sha256: binary.sha256,
        size_bytes: binary.sizeBytes,
        mime_type: binary.mimeType,
      }
    }),
  )
  return documentIds
}

/**
 * Importe un zip uploadé comme nouveau projet dont l'utilisateur est propriétaire, dans le
 * workspace demandé (dont il doit être membre) ou sinon son workspace personnel. Les binaires
 * vont sous `projects/{id}/files/` ; en cas d'échec, ce préfixe est supprimé.
 */
export async function completeImport(
  storage: ObjectStorage,
  user: User,
  uploadId: string,
  workspaceId?: string,
): Promise<Project> {
  const upload = await pendingUpload({ id: uploadId, userId: user.id, purpose: 'import' })
  // Vérifié avant le travail (refait dans la transaction) : un refus laisse l'upload en attente.
  if (workspaceId !== undefined) await workspaceFor(user, workspaceId)
  const zipPath = join(tmpdir(), `kaxolax-import-${upload.id}.zip`)
  const projectId = randomUUID()
  try {
    const size = await storage.size(upload.s3Key)
    if (size === null) {
      throw new UploadInvalidException('The upload was not found', { code: 'E_UPLOAD_MISSING' })
    }
    if (size !== upload.sizeBytes || size > MAX_IMPORT_ZIP_BYTES) {
      throw new UploadInvalidException('The uploaded size does not match', {
        code: 'E_UPLOAD_SIZE_MISMATCH',
      })
    }
    if ((await storage.download(upload.s3Key, zipPath)) !== size) {
      throw new UploadInvalidException('The upload changed while reading it', {
        code: 'E_UPLOAD_SIZE_MISMATCH',
      })
    }

    const plan = await importZip<StoredBinary>(zipPath, async ({ sizeBytes, mimeType, body }) => {
      const fileId = randomUUID()
      const key = fileKey(projectId, fileId)
      await storage.put(key, body, sizeBytes, mimeType)
      return { fileId, key }
    }).catch((error: unknown) => {
      if (error instanceof ZipImportError) {
        throw new UploadInvalidException(error.message, { code: error.code })
      }
      throw error
    })

    const project = await db.transaction(async (trx) => {
      const workspace = await workspaceForNewProject(user, workspaceId, trx)
      const created = await Project.create(
        {
          id: projectId,
          ownerId: user.id,
          workspaceId: workspace.id,
          name: projectNameFrom(upload.filename),
          compiler: plan.compiler,
          spellcheckLanguage: DEFAULT_SPELLCHECK_LANGUAGE,
        },
        { client: trx },
      )
      await ProjectMember.create({ projectId, userId: user.id, role: 'owner' }, { client: trx })
      const documentIds = await insertTree(trx, projectId, plan, user.id)
      created.mainDocumentId =
        plan.mainDocumentPath === null ? null : (documentIds.get(plan.mainDocumentPath) ?? null)
      await created.useTransaction(trx).save()
      await Upload.query({ client: trx })
        .where('id', upload.id)
        .update({ status: 'completed', projectId })
      return created
    })
    await storage.delete([upload.s3Key])
    return project
  } catch (error) {
    await storage.deletePrefix(projectPrefix(projectId))
    await markFailed(storage, upload)
    if (!(error instanceof UploadInvalidException)) {
      logger.error({ err: error, uploadId: upload.id }, 'zip import failed')
    }
    throw error
  } finally {
    await rm(zipPath, { force: true })
  }
}
