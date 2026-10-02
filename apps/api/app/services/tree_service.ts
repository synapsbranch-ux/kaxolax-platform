import { createHash } from 'node:crypto'
import { createDocumentState } from '@kaxolax/collab'
import { Exception } from '@adonisjs/core/exceptions'
import { type TransactionClientContract } from '@adonisjs/lucid/types/database'
import { DateTime } from 'luxon'
import Document from '#models/document'
import File from '#models/file'
import Folder from '#models/folder'
import Project from '#models/project'
import { isUuid } from '#services/project_access'

export type EntityType = 'folder' | 'document' | 'file'

export class NameTakenException extends Exception {
  static override status = 409
  static override code = 'E_NAME_TAKEN'
  static override message = 'An item with this name already exists in this folder'
}

export class EntityNotFoundException extends Exception {
  static override status = 404
  static override code = 'E_ENTITY_NOT_FOUND'
  static override message = 'Item not found'
}

export class InvalidMoveException extends Exception {
  static override status = 422
  static override code = 'E_INVALID_MOVE'
  static override message = 'A folder cannot be moved into itself or one of its subfolders'
}

export function sha256(text: string | Uint8Array): string {
  return createHash('sha256').update(text).digest('hex')
}

/**
 * Un nom est unique dans un dossier, tous types confondus. À appeler dans une transaction qui a
 * verrouillé la ligne du projet : les modifications d'arborescence d'un projet sont sérialisées.
 */
export async function assertNameAvailable(
  trx: TransactionClientContract,
  projectId: string,
  folderId: string | null,
  name: string,
  except?: { type: EntityType; id: string },
): Promise<void> {
  const tables: { type: EntityType; table: string; parentColumn: string }[] = [
    { type: 'folder', table: 'folders', parentColumn: 'parent_id' },
    { type: 'document', table: 'documents', parentColumn: 'folder_id' },
    { type: 'file', table: 'files', parentColumn: 'folder_id' },
  ]
  for (const { type, table, parentColumn } of tables) {
    const query = trx.from(table).where('project_id', projectId).where('name', name)
    if (folderId === null) void query.whereNull(parentColumn)
    else void query.where(parentColumn, folderId)
    if (except?.type === type) void query.whereNot('id', except.id)
    if (await query.first()) throw new NameTakenException()
  }
}

/** Vérifie qu'un dossier (ou la racine, `null`) appartient au projet. */
export async function assertFolder(
  trx: TransactionClientContract,
  projectId: string,
  folderId: string | null,
): Promise<void> {
  if (folderId === null) return
  if (!isUuid(folderId)) throw new EntityNotFoundException('Folder not found')
  const folder = await Folder.query({ client: trx }).where({ id: folderId, projectId }).first()
  if (!folder) throw new EntityNotFoundException('Folder not found')
}

export async function createFolder(
  trx: TransactionClientContract,
  projectId: string,
  input: { name: string; parentId: string | null },
): Promise<Folder> {
  await assertFolder(trx, projectId, input.parentId)
  await assertNameAvailable(trx, projectId, input.parentId, input.name)
  return Folder.create({ projectId, parentId: input.parentId, name: input.name }, { client: trx })
}

export async function createDocument(
  trx: TransactionClientContract,
  projectId: string,
  input: { name: string; folderId: string | null; content: string },
): Promise<Document> {
  await assertFolder(trx, projectId, input.folderId)
  await assertNameAvailable(trx, projectId, input.folderId, input.name)
  return Document.create(
    {
      projectId,
      folderId: input.folderId,
      name: input.name,
      yjsState: Buffer.from(createDocumentState(input.content)),
      contentSha256: sha256(input.content),
    },
    { client: trx },
  )
}

/** Fichier binaire dont le contenu est déjà dans S3 (clé `s3Key`). */
export async function createFile(
  trx: TransactionClientContract,
  projectId: string,
  input: {
    id: string
    name: string
    folderId: string | null
    s3Key: string
    sha256: string
    sizeBytes: number
    mimeType: string
  },
): Promise<File> {
  await assertFolder(trx, projectId, input.folderId)
  await assertNameAvailable(trx, projectId, input.folderId, input.name)
  return File.create({ projectId, ...input }, { client: trx })
}

/** Toute modification de l'arborescence met à jour la date du projet (tri du dashboard). */
export async function touchProject(trx: TransactionClientContract, projectId: string) {
  await Project.query({ client: trx })
    .where('id', projectId)
    .update({ updatedAt: DateTime.utc().toSQL() })
}

type Entity = Folder | Document | File

async function findEntity(
  trx: TransactionClientContract,
  projectId: string,
  type: EntityType,
  id: string,
): Promise<Entity> {
  if (!isUuid(id)) throw new EntityNotFoundException()
  const model = type === 'folder' ? Folder : type === 'document' ? Document : File
  const entity = await model.query({ client: trx }).where({ id, projectId }).first()
  if (!entity) throw new EntityNotFoundException()
  return entity
}

/** Dossier parent d'une entité (null : racine du projet). */
export function parentOf(entity: Entity): string | null {
  return entity instanceof Folder ? entity.parentId : entity.folderId
}

/** Renomme et/ou déplace une entité. `folderId` : dossier de destination (`null` = racine). */
export async function updateEntity(
  trx: TransactionClientContract,
  projectId: string,
  type: EntityType,
  id: string,
  changes: { name?: string; folderId?: string | null },
): Promise<Entity> {
  const entity = await findEntity(trx, projectId, type, id)
  const targetFolder = changes.folderId === undefined ? parentOf(entity) : changes.folderId
  const name = changes.name ?? entity.name

  if (changes.folderId !== undefined) {
    await assertFolder(trx, projectId, targetFolder)
    if (entity instanceof Folder && targetFolder !== null) {
      // On remonte depuis la destination : si on croise le dossier déplacé, c'est un cycle.
      let current: string | null = targetFolder
      while (current !== null) {
        if (current === entity.id) throw new InvalidMoveException()
        const parent: Folder | null = await Folder.find(current, { client: trx })
        current = parent?.parentId ?? null
      }
    }
  }
  await assertNameAvailable(trx, projectId, targetFolder, name, { type, id: entity.id })

  entity.name = name
  if (entity instanceof Folder) entity.parentId = targetFolder
  else entity.folderId = targetFolder
  await entity.useTransaction(trx).save()
  return entity
}

export interface DeletedEntities {
  documentIds: string[]
  fileKeys: string[]
}

/**
 * Supprime une entité (un dossier avec tout son contenu). Renvoie les documents supprimés (à fermer
 * côté temps réel) et les clés S3 des fichiers (à supprimer du stockage).
 */
export async function deleteEntity(
  trx: TransactionClientContract,
  projectId: string,
  type: EntityType,
  id: string,
): Promise<DeletedEntities> {
  const entity = await findEntity(trx, projectId, type, id)
  const deleted: DeletedEntities = { documentIds: [], fileKeys: [] }
  if (entity instanceof Document) {
    deleted.documentIds.push(entity.id)
  } else if (entity instanceof File) {
    deleted.fileKeys.push(entity.s3Key)
  } else {
    const folders = await trx.rawQuery<{ rows: { id: string }[] }>(
      `WITH RECURSIVE tree AS (
         SELECT id FROM folders WHERE id = ? AND project_id = ?
         UNION ALL
         SELECT f.id FROM folders f JOIN tree t ON f.parent_id = t.id
       ) SELECT id FROM tree`,
      [entity.id, projectId],
    )
    const folderIds = folders.rows.map((row) => row.id)
    const documents = await Document.query({ client: trx })
      .whereIn('folderId', folderIds)
      .select('id')
    const files = await File.query({ client: trx }).whereIn('folderId', folderIds).select('s3Key')
    deleted.documentIds.push(...documents.map((document) => document.id))
    deleted.fileKeys.push(...files.map((file) => file.s3Key))
  }
  // Les sous-dossiers, documents et fichiers suivent par ON DELETE CASCADE.
  await entity.useTransaction(trx).delete()
  return deleted
}

export interface TreeResponse {
  folders: { id: string; parentId: string | null; name: string; path: string }[]
  documents: {
    id: string
    folderId: string | null
    name: string
    path: string
    updatedAt: string
  }[]
  files: {
    id: string
    folderId: string | null
    name: string
    path: string
    sizeBytes: number
    mimeType: string
    createdAt: string
  }[]
}

/** Arborescence d'un projet ; les chemins sont calculés, jamais stockés. */
export async function buildTree(
  projectId: string,
  client?: TransactionClientContract,
): Promise<TreeResponse> {
  // Requêtes successives : une transaction n'exécute qu'une requête à la fois (pg 9 l'imposera).
  const folders = await Folder.query({ client }).where('projectId', projectId).orderBy('name')
  const documents = await Document.query({ client })
    .where('projectId', projectId)
    .orderBy('name')
    .select('id', 'folderId', 'name', 'updatedAt')
  const files = await File.query({ client }).where('projectId', projectId).orderBy('name')
  const byId = new Map(folders.map((folder) => [folder.id, folder]))
  const paths = new Map<string, string>()
  const folderPath = (id: string, seen = new Set<string>()): string => {
    const cached = paths.get(id)
    if (cached !== undefined) return cached
    const folder = byId.get(id)
    if (!folder || seen.has(id)) return ''
    seen.add(id)
    const path =
      folder.parentId === null ? folder.name : `${folderPath(folder.parentId, seen)}/${folder.name}`
    paths.set(id, path)
    return path
  }
  const join = (folderId: string | null, name: string) =>
    folderId === null ? name : `${folderPath(folderId)}/${name}`

  return {
    folders: folders.map((folder) => ({
      id: folder.id,
      parentId: folder.parentId,
      name: folder.name,
      path: folderPath(folder.id),
    })),
    documents: documents.map((document) => ({
      id: document.id,
      folderId: document.folderId,
      name: document.name,
      path: join(document.folderId, document.name),
      updatedAt: document.updatedAt.toISO() ?? '',
    })),
    files: files.map((file) => ({
      id: file.id,
      folderId: file.folderId,
      name: file.name,
      path: join(file.folderId, file.name),
      sizeBytes: file.sizeBytes,
      mimeType: file.mimeType,
      createdAt: file.createdAt.toISO() ?? '',
    })),
  }
}
