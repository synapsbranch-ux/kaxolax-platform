import { randomUUID } from 'node:crypto'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDocumentState } from '@kaxolax/collab'
import {
  type Compiler,
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
import { accountForNewProject } from '#services/entitlements'
import { assertProjectStorageAvailable, assertStorageAvailable } from '#services/plan_enforcement'
import { projectFor } from '#services/project_access'
import {
  assertFolder,
  assertNameAvailable,
  createDocument,
  createFile,
  recordInitialStates,
  touchProject,
} from '#services/tree_service'
import { checkNewProjectWorkspace, workspaceForNewProject } from '#services/workspace_service'

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
  // Vérifications anticipées (refaites à la complétion) : pas d'upload pour un nom déjà pris ni
  // au-delà du stockage du plan du propriétaire.
  await assertProjectStorageAvailable(project, input.sizeBytes, { requester: user })
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
      // Propriétaire relu sous verrou : un transfert pendant le traitement change le compte débité.
      const { project: lockedProject } = await projectFor(user, project.id, 'edit', {
        trx,
        lock: true,
      })
      const locked = await pendingUpload(
        { id: upload.id, userId: user.id, purpose: 'file', projectId: project.id },
        trx,
      )
      await assertProjectStorageAvailable(
        lockedProject,
        processed.kind === 'text'
          ? Buffer.byteLength(processed.content, 'utf8')
          : processed.sizeBytes,
        { requester: user, trx },
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

/**
 * Début d'un import zip : `workspaceId` (facultatif) annonce le workspace du futur projet. Refus
 * anticipés, avant l'upload : workspace (membre avec `createProject`, plan d'équipe actif) et
 * taille du zip contre le stockage du compte qui recevra le projet (stockage mutualisé de
 * l'équipe, sinon personnel). Le contenu extrait est compté de nouveau à la complétion.
 */
export async function startImport(
  storage: ObjectStorage,
  user: User,
  input: { filename: string; sizeBytes: number; workspaceId?: string },
): Promise<StartedUpload> {
  await checkNewProjectWorkspace(user, input.workspaceId)
  await assertStorageAvailable(
    await accountForNewProject(user, input.workspaceId),
    input.sizeBytes,
    { requester: user },
  )
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

/** Options de `createProjectFromZip`. */
export interface ZipProjectOptions {
  name: string
  /** Workspace dont l'utilisateur est membre ; absent : son workspace personnel. */
  workspaceId?: string
  /** Compilateur imposé (template) ; absent : celui détecté dans le document principal. */
  compiler?: Compiler
  /** Document principal imposé s'il existe dans le zip ; sinon celui que trouve l'import. */
  mainDocumentPath?: string
  /** Écritures supplémentaires dans la transaction de création (statut de l'upload). */
  inTransaction?: (trx: TransactionClientContract, projectId: string) => Promise<void>
}

/**
 * Crée un projet dont l'utilisateur est propriétaire à partir d'un zip local (`importZip` :
 * arborescence, documents Yjs, binaires sous `projects/{id}/files/`). Le contenu extrait est
 * compté dans le stockage du plan de l'utilisateur. En cas d'échec, le préfixe S3 du projet est
 * supprimé.
 */
export async function createProjectFromZip(
  storage: ObjectStorage,
  user: User,
  zipPath: string,
  options: ZipProjectOptions,
): Promise<Project> {
  const projectId = randomUUID()
  try {
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

    return await db.transaction(async (trx) => {
      // Le projet importé appartient à l'utilisateur : le stockage de son compte (ou de l'équipe du
      // workspace choisi) reçoit le contenu extrait.
      const importedBytes =
        plan.binaries.reduce((sum, binary) => sum + binary.sizeBytes, 0) +
        plan.documents.reduce(
          (sum, document) => sum + Buffer.byteLength(document.content, 'utf8'),
          0,
        )
      const workspace = await workspaceForNewProject(user, options.workspaceId, trx)
      await assertStorageAvailable(
        await accountForNewProject(user, workspace.id, trx),
        importedBytes,
        { requester: user, trx },
      )
      const created = await Project.create(
        {
          id: projectId,
          ownerId: user.id,
          workspaceId: workspace.id,
          name: options.name,
          compiler: options.compiler ?? plan.compiler,
          spellcheckLanguage: DEFAULT_SPELLCHECK_LANGUAGE,
        },
        { client: trx },
      )
      await ProjectMember.create({ projectId, userId: user.id, role: 'owner' }, { client: trx })
      const documentIds = await insertTree(trx, projectId, plan, user.id)
      const mainPath =
        options.mainDocumentPath !== undefined && documentIds.has(options.mainDocumentPath)
          ? options.mainDocumentPath
          : plan.mainDocumentPath
      created.mainDocumentId = mainPath === null ? null : (documentIds.get(mainPath) ?? null)
      await created.useTransaction(trx).save()
      await options.inTransaction?.(trx, projectId)
      return created
    })
  } catch (error) {
    await storage.deletePrefix(projectPrefix(projectId))
    throw error
  }
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
  await checkNewProjectWorkspace(user, workspaceId)
  const zipPath = join(tmpdir(), `kaxolax-import-${upload.id}.zip`)
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

    const project = await createProjectFromZip(storage, user, zipPath, {
      name: projectNameFrom(upload.filename),
      workspaceId,
      inTransaction: async (trx, projectId) => {
        await Upload.query({ client: trx })
          .where('id', upload.id)
          .update({ status: 'completed', projectId })
      },
    })
    await storage.delete([upload.s3Key])
    return project
  } catch (error) {
    await markFailed(storage, upload)
    if (!(error instanceof UploadInvalidException)) {
      logger.error({ err: error, uploadId: upload.id }, 'zip import failed')
    }
    throw error
  } finally {
    await rm(zipPath, { force: true })
  }
}
