import { posix } from 'node:path'
import {
  HISTORY_ERRORS,
  type RestoreVersionInput,
  type RestoreVersionResponse,
  type VersionManifest,
} from '@kaxolax/contracts'
import { Exception } from '@adonisjs/core/exceptions'
import logger from '@adonisjs/core/services/logger'
import db from '@adonisjs/lucid/services/db'
import { type TransactionClientContract } from '@adonisjs/lucid/types/database'
import Document from '#models/document'
import File from '#models/file'
import Folder from '#models/folder'
import Project from '#models/project'
import ProjectVersion from '#models/project_version'
import type User from '#models/user'
import {
  createVersion,
  createVersionSafely,
  type HistoryDependencies,
  lockHistory,
  readManifest,
  readVersionText,
  releaseFileObjects,
  restoredDocumentState,
  VersionNotFoundException,
} from '#services/history_service'
import { assertStorageAvailable, projectStorageUsage } from '#services/plan_enforcement'
import { isUuid, projectFor } from '#services/project_access'
import {
  assertNameAvailable,
  buildTree,
  NameTakenException,
  recordInitialStates,
  sha256,
  touchProject,
} from '#services/tree_service'

/**
 * Restauration d'une version (tout le projet, ou un fichier) : une version de l'état courant est
 * d'abord créée (rien n'est perdu), puis le texte des documents existants est remplacé par le
 * service temps réel (les clients connectés reçoivent la mise à jour Yjs), enfin l'arborescence
 * est remise dans l'état de la version (documents et fichiers recréés avec leur identifiant,
 * déplacés, ou supprimés ; dossiers ; document principal). Une fois la restauration réussie, une
 * version de l'état restauré (`restored`) est créée tout de suite, au nom de la personne qui
 * restaure : l'historique ne dépend pas du prochain balayage des versions automatiques.
 *
 * Le remplacement des textes ne peut pas faire partie de la transaction : si un remplacement ou
 * la transaction échoue, les textes déjà remplacés sont remis dans l'état de la version de
 * sauvegarde (rien n'est modifié). Si cette remise échoue aussi, l'erreur le dit
 * (`E_HISTORY_RESTORE_INCOMPLETE`) : relancer la restauration la termine.
 *
 * Verrous dans le même ordre que `createVersion` : verrou consultatif de l'historique, puis ligne
 * du projet (sinon interblocage avec une version automatique ou de compilation).
 */

export class VersionEntryNotFoundException extends Exception {
  static override status = 404
  static override code = HISTORY_ERRORS.entryNotFound
  static override message = 'This file is not part of the version'
}

export class RestorePathTakenException extends Exception {
  static override status = 409
  static override code = HISTORY_ERRORS.pathTaken
  static override message = 'Another item now uses the path of the restored file'
}

export class HistoryRealtimeUnavailableException extends Exception {
  static override status = 503
  static override code = HISTORY_ERRORS.realtimeUnavailable
  static override message =
    'The restored text could not be applied and nothing was changed. Try again in a moment.'
}

export class RestoreIncompleteException extends Exception {
  static override status = 503
  static override code = HISTORY_ERRORS.restoreIncomplete
  static override message =
    'The restore was interrupted and the project is partly restored. Restore the version again; the backup version keeps the previous state.'
}

/** Version d'un projet (404 si elle n'existe pas ou a été purgée). */
export async function findVersion(
  projectId: string,
  versionId: string,
  trx?: TransactionClientContract,
): Promise<ProjectVersion> {
  if (!isUuid(versionId)) throw new VersionNotFoundException()
  const version = await ProjectVersion.query({ client: trx })
    .where({ projectId, id: versionId })
    .first()
  if (!version) throw new VersionNotFoundException()
  return version
}

type ManifestDocument = VersionManifest['documents'][number]
type ManifestFile = VersionManifest['files'][number]

/** Nom temporaire d'un élément déplacé (les noms sont uniques par dossier et par type). */
const temporaryName = (id: string) => `~restore~${id}`

const depth = (path: string) => path.split('/').length

/** Dossiers d'un chemin créés au besoin ; renvoie l'identifiant du dossier parent du chemin. */
async function ensureFolders(
  trx: TransactionClientContract,
  projectId: string,
  folderIds: Map<string, string>,
  directory: string,
): Promise<string | null> {
  if (directory === '' || directory === '.') return null
  const existing = folderIds.get(directory)
  if (existing) return existing
  const parentId = await ensureFolders(trx, projectId, folderIds, posix.dirname(directory))
  const folder = await Folder.create(
    { projectId, parentId, name: posix.basename(directory) },
    { client: trx },
  )
  folderIds.set(directory, folder.id)
  return folder.id
}

async function createDocumentWithId(
  trx: TransactionClientContract,
  projectId: string,
  document: ManifestDocument,
  folderId: string | null,
  text: string,
  authorId: string,
): Promise<void> {
  const state = restoredDocumentState(text)
  await Document.create(
    {
      id: document.id,
      projectId,
      folderId,
      name: posix.basename(document.path),
      yjsState: state,
      contentSha256: sha256(text),
    },
    { client: trx },
  )
  await recordInitialStates(trx, [{ projectId, documentId: document.id, userId: authorId, state }])
}

async function createFileWithId(
  trx: TransactionClientContract,
  projectId: string,
  file: ManifestFile,
  folderId: string | null,
): Promise<void> {
  await File.create(
    {
      id: file.id,
      projectId,
      folderId,
      name: posix.basename(file.path),
      s3Key: file.s3Key,
      sha256: file.sha256,
      sizeBytes: file.sizeBytes,
      mimeType: file.mimeType,
    },
    { client: trx },
  )
}

interface TreeOutcome {
  deletedDocumentIds: string[]
  deletedFiles: { id: string; s3Key: string }[]
}

/** Arborescence remise dans l'état exact de la version (restauration du projet entier). */
async function restoreWholeTree(
  trx: TransactionClientContract,
  project: Project,
  manifest: VersionManifest,
  texts: ReadonlyMap<string, string>,
  authorId: string,
): Promise<TreeOutcome> {
  const tree = await buildTree(project.id, trx)
  const targetDocuments = new Map(manifest.documents.map((document) => [document.id, document]))
  const targetFiles = new Map(manifest.files.map((file) => [file.id, file]))
  const targetFolders = new Set(manifest.folders)

  // 1. Ce que la version n'a pas (sauvegardé dans la version créée avant la restauration).
  const deletedDocumentIds = tree.documents
    .filter((document) => !targetDocuments.has(document.id))
    .map((document) => document.id)
  if (deletedDocumentIds.length > 0) {
    await Document.query({ client: trx }).whereIn('id', deletedDocumentIds).delete()
  }
  const removedFileIds = tree.files
    .filter((file) => !targetFiles.has(file.id))
    .map((file) => file.id)
  const deletedFiles =
    removedFileIds.length === 0
      ? []
      : (await File.query({ client: trx }).whereIn('id', removedFileIds).select('id', 's3Key')).map(
          (file) => ({ id: file.id, s3Key: file.s3Key }),
        )
  if (removedFileIds.length > 0) {
    await File.query({ client: trx }).whereIn('id', removedFileIds).delete()
  }

  // 2. Dossiers de la version (ceux qui existent déjà au même chemin sont gardés).
  const folderIds = new Map(tree.folders.map((folder) => [folder.path, folder.id]))
  for (const path of [...targetFolders].sort((a, b) => depth(a) - depth(b))) {
    await ensureFolders(trx, project.id, folderIds, path)
  }
  const placeOf = (path: string) => ({
    folderId: folderIds.get(posix.dirname(path)) ?? null,
    name: posix.basename(path),
  })

  // 3. Déplacements en deux temps : noms temporaires, puis places de la version.
  const movedDocuments = tree.documents.filter((document) => {
    const target = targetDocuments.get(document.id)
    if (!target) return false
    const place = placeOf(target.path)
    return place.folderId !== document.folderId || place.name !== document.name
  })
  const movedFiles = tree.files.filter((file) => {
    const target = targetFiles.get(file.id)
    if (!target) return false
    const place = placeOf(target.path)
    return place.folderId !== file.folderId || place.name !== file.name
  })
  for (const document of movedDocuments) {
    await Document.query({ client: trx })
      .where('id', document.id)
      .update({ name: temporaryName(document.id) })
  }
  for (const file of movedFiles) {
    await File.query({ client: trx })
      .where('id', file.id)
      .update({ name: temporaryName(file.id) })
  }
  for (const document of movedDocuments) {
    const target = targetDocuments.get(document.id)
    if (!target) continue
    await Document.query({ client: trx }).where('id', document.id).update(placeOf(target.path))
  }
  for (const file of movedFiles) {
    const target = targetFiles.get(file.id)
    if (!target) continue
    await File.query({ client: trx }).where('id', file.id).update(placeOf(target.path))
  }

  // 4. Documents et fichiers supprimés depuis : recréés avec leur identifiant.
  const currentDocuments = new Set(tree.documents.map((document) => document.id))
  for (const document of manifest.documents) {
    if (currentDocuments.has(document.id)) continue
    const { folderId } = placeOf(document.path)
    await createDocumentWithId(
      trx,
      project.id,
      document,
      folderId,
      texts.get(document.id) ?? '',
      authorId,
    )
  }
  const currentFiles = new Set(tree.files.map((file) => file.id))
  for (const file of manifest.files) {
    if (currentFiles.has(file.id)) continue
    await createFileWithId(trx, project.id, file, placeOf(file.path).folderId)
  }

  // 5. Dossiers absents de la version, les plus profonds d'abord (vides à ce stade).
  const obsolete = tree.folders
    .filter((folder) => !targetFolders.has(folder.path))
    .sort((a, b) => depth(b.path) - depth(a.path))
  for (const folder of obsolete) {
    await Folder.query({ client: trx }).where('id', folder.id).delete()
  }

  // 6. Document principal de la version.
  await Project.query({ client: trx })
    .where('id', project.id)
    .update({ mainDocumentId: manifest.mainDocumentId })
  return { deletedDocumentIds, deletedFiles }
}

/**
 * Un fichier de la version, recréé à son chemin s'il a été supprimé depuis. Un document ou un
 * fichier qui occupe désormais ce chemin (supprimé puis recréé sous le même nom) est remplacé : il
 * reste dans la version de sauvegarde. Un dossier au même chemin : 409.
 */
async function restoreOneEntry(
  trx: TransactionClientContract,
  project: Project,
  entry: { document: ManifestDocument; text: string } | { file: ManifestFile },
  authorId: string,
): Promise<TreeOutcome> {
  const outcome: TreeOutcome = { deletedDocumentIds: [], deletedFiles: [] }
  const id = 'document' in entry ? entry.document.id : entry.file.id
  const path = 'document' in entry ? entry.document.path : entry.file.path
  const exists =
    'document' in entry
      ? await Document.query({ client: trx }).where({ id, projectId: project.id }).first()
      : await File.query({ client: trx }).where({ id, projectId: project.id }).first()
  // Toujours dans l'arborescence : texte remplacé par le service temps réel ; un binaire ne change
  // jamais de contenu sous un même identifiant.
  if (exists) return outcome
  const tree = await buildTree(project.id, trx)
  const folderIds = new Map(tree.folders.map((folder) => [folder.path, folder.id]))
  const folderId = await ensureFolders(trx, project.id, folderIds, posix.dirname(path))
  const name = posix.basename(path)
  const occupyingDocument = tree.documents.find((document) => document.path === path)
  const occupyingFile = tree.files.find((file) => file.path === path)
  if (occupyingDocument) {
    await Document.query({ client: trx }).where('id', occupyingDocument.id).delete()
    outcome.deletedDocumentIds.push(occupyingDocument.id)
  }
  if (occupyingFile) {
    const row = await File.query({ client: trx }).where('id', occupyingFile.id).first()
    if (row) {
      await row.useTransaction(trx).delete()
      outcome.deletedFiles.push({ id: row.id, s3Key: row.s3Key })
    }
  }
  try {
    await assertNameAvailable(trx, project.id, folderId, name)
  } catch (error) {
    if (error instanceof NameTakenException) throw new RestorePathTakenException()
    throw error
  }
  if ('document' in entry) {
    await createDocumentWithId(trx, project.id, entry.document, folderId, entry.text, authorId)
  } else {
    await createFileWithId(trx, project.id, entry.file, folderId)
  }
  return outcome
}

/**
 * Remet les textes déjà remplacés dans l'état de la version de sauvegarde. Renvoie faux si l'un
 * d'eux n'a pas pu l'être.
 */
async function revertTexts(
  deps: HistoryDependencies,
  projectId: string,
  backup: ProjectVersion,
  documentIds: readonly string[],
  userId: string,
): Promise<boolean> {
  if (documentIds.length === 0) return true
  try {
    const manifest = await readManifest(deps.storage, backup)
    const shaById = new Map(manifest.documents.map((document) => [document.id, document.sha256]))
    let complete = true
    for (const documentId of documentIds) {
      const textSha = shaById.get(documentId)
      if (textSha === undefined) {
        complete = false
        continue
      }
      const content = await readVersionText(deps.storage, projectId, textSha)
      const reverted = await deps.realtime.replaceDocument(projectId, documentId, {
        content,
        userId,
      })
      if (!reverted) complete = false
    }
    return complete
  } catch (error) {
    logger.error({ err: error, projectId }, 'could not revert restored texts')
    return false
  }
}

export async function restoreVersion(
  deps: HistoryDependencies,
  user: User,
  projectId: string,
  versionId: string,
  input: RestoreVersionInput,
): Promise<RestoreVersionResponse> {
  const { project } = await projectFor(user, projectId, 'edit')
  const version = await findVersion(project.id, versionId)
  const manifest = await readManifest(deps.storage, version)

  let documents = manifest.documents
  let files = manifest.files
  if (input.scope === 'entry') {
    documents = documents.filter((document) => document.id === input.entryId)
    files = files.filter((file) => file.id === input.entryId)
    if (documents.length + files.length === 0) throw new VersionEntryNotFoundException()
  }
  const texts = new Map<string, string>()
  for (const document of documents) {
    texts.set(document.id, await readVersionText(deps.storage, project.id, document.sha256))
  }

  // L'état courant d'abord : la restauration ne fait rien perdre.
  const backup = await createVersion(deps, project.id, { kind: 'restore', actorId: user.id })
  if (!backup) throw new VersionNotFoundException()

  // Texte des documents encore présents : par le service temps réel (clients connectés).
  const stored = (await db
    .from('documents')
    .where('project_id', project.id)
    .whereIn(
      'id',
      documents.map((document) => document.id),
    )
    .select('id', db.raw('octet_length(yjs_state) AS state_bytes'))) as {
    id: string
    state_bytes: string | number
  }[]
  const existing = new Set(stored.map((document) => document.id))
  // Stockage du propriétaire (tâche 12) : un texte restauré plus long que l'état enregistré du
  // document ajoute du contenu (estimation basse, l'état Yjs contient au moins le texte). Refus
  // 403 `E_PLAN_LIMIT` avant toute modification ; l'arborescence est vérifiée dans la transaction.
  const textGrowth = stored.reduce(
    (sum, document) =>
      sum +
      Math.max(
        0,
        Buffer.byteLength(texts.get(document.id) ?? '', 'utf8') - Number(document.state_bytes),
      ),
    0,
  )
  if (textGrowth > 0) await assertStorageAvailable(project.ownerId, textGrowth, { requester: user })
  const replaced: string[] = []
  const fail = async (error: unknown): Promise<never> => {
    if (await revertTexts(deps, project.id, backup.version, replaced, user.id)) throw error
    logger.error({ err: error, projectId: project.id, versionId }, 'restore left incomplete')
    throw new RestoreIncompleteException()
  }
  for (const document of documents) {
    if (!existing.has(document.id)) continue
    const done = await deps.realtime.replaceDocument(project.id, document.id, {
      content: texts.get(document.id) ?? '',
      userId: user.id,
    })
    if (!done) await fail(new HistoryRealtimeUnavailableException())
    replaced.push(document.id)
  }

  let outcome: TreeOutcome
  try {
    outcome = await db.transaction(async (trx): Promise<TreeOutcome> => {
      // Même ordre que createVersion : verrou de l'historique, puis ligne du projet.
      await lockHistory(trx, project.id)
      const { project: locked } = await projectFor(user, project.id, 'edit', { trx, lock: true })
      // Version purgée depuis sa lecture : ses binaires ont pu quitter le stockage (404).
      await findVersion(project.id, versionId, trx)
      // Stockage du propriétaire (tâche 12) : mesuré avant et après la remise de l'arborescence.
      const usedBefore = await projectStorageUsage(project.id, trx)
      let result: TreeOutcome = { deletedDocumentIds: [], deletedFiles: [] }
      if (input.scope === 'project') {
        result = await restoreWholeTree(trx, locked, manifest, texts, user.id)
      } else {
        const [document] = documents
        const [file] = files
        if (document) {
          result = await restoreOneEntry(
            trx,
            locked,
            { document, text: texts.get(document.id) ?? '' },
            user.id,
          )
        } else if (file) {
          result = await restoreOneEntry(trx, locked, { file }, user.id)
        }
      }
      // Documents ou fichiers recréés : 403 `E_PLAN_LIMIT` (tout est annulé, textes compris) si
      // le stockage du plan ne les accueille pas ; une restauration qui libère passe toujours.
      const added = (await projectStorageUsage(project.id, trx)) - usedBefore
      if (added > 0) {
        await assertStorageAvailable(locked.ownerId, added, { requester: user, trx, applied: true })
      }
      await touchProject(trx, project.id)
      return result
    })
  } catch (error) {
    return fail(error)
  }

  await deps.realtime.closeDocuments(outcome.deletedDocumentIds)
  // Binaires retirés : gardés, la version de sauvegarde les référence.
  await releaseFileObjects(deps.storage, project.id, outcome.deletedFiles)
  await deps.realtime.publishProjectEvent(project.id, {
    type: 'tree.changed',
    reason: 'restore',
    actorId: user.id,
    changes: [],
    ...(input.scope === 'project' ? { mainDocumentId: manifest.mainDocumentId } : {}),
  })
  // État restauré : au mieux (la restauration est faite ; en cas d'échec, le balayage des
  // versions automatiques le rattrape, sans auteur garanti).
  const restored = await createVersionSafely(deps, project.id, {
    kind: 'restored',
    actorId: user.id,
    authorIds: [user.id],
  })
  return {
    backupVersionId: backup.version.id,
    restoredVersionId: restored?.created ? restored.version.id : null,
    restored: { documents: documents.length, files: files.length },
  }
}
