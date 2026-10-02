import { randomUUID } from 'node:crypto'
import { gunzipSync, gzipSync } from 'node:zlib'
import { createDocumentState, type AttributedUpdate, replayWithAttribution } from '@kaxolax/collab'
import {
  type DiffSegment,
  diffSegmentSchema,
  type ProjectVersion as ProjectVersionContract,
  VERSION_MANIFEST_VERSION,
  type VersionAuthor,
  type VersionEntry,
  type VersionKind,
  type VersionManifest,
  versionManifestSchema,
} from '@kaxolax/contracts'
import { Exception } from '@adonisjs/core/exceptions'
import logger from '@adonisjs/core/services/logger'
import db from '@adonisjs/lucid/services/db'
import { type TransactionClientContract } from '@adonisjs/lucid/types/database'
import { DateTime } from 'luxon'
import File from '#models/file'
import Project from '#models/project'
import ProjectVersion from '#models/project_version'
import User from '#models/user'
import VersionDocument from '#models/version_document'
import VersionFile from '#models/version_file'
import type ObjectStorage from '#services/object_storage'
import { fileKey, projectPrefix } from '#services/object_storage'
import type RealtimeClient from '#services/realtime_client'
import { buildTree, sha256 } from '#services/tree_service'

/**
 * Historique du projet (tâche 8). Une version fige l'arborescence (manifeste dans le stockage
 * objet), le texte de chaque document (compressé, adressé par sha256 : un texte inchangé n'est pas
 * réécrit) et référence les binaires (table version_files : leur objet reste tant qu'une version
 * y fait référence).
 *
 * Le texte d'un document dans une version est reconstruit depuis le journal des mises à jour Yjs
 * (table document_updates, écrite par le service temps réel avec l'auteur de chaque mise à jour) :
 * base compactée des versions précédentes, puis mises à jour pas encore versionnées, rejouées une
 * à une pour attribuer chaque changement à son auteur ; l'état enregistré du document est appliqué
 * en dernier, sans auteur, pour rattraper ce que le journal aurait manqué. Les mises à jour
 * intégrées sont ensuite compactées en une ligne par document.
 *
 * Toutes les opérations qui créent une version, en purgent ou suppriment un binaire prennent le
 * verrou consultatif de l'historique du projet (`lockHistory`) : une seule à la fois par projet,
 * quel que soit le nombre d'instances de l'API.
 */

export class VersionNotFoundException extends Exception {
  static override status = 404
  static override code = 'E_VERSION_NOT_FOUND'
  static override message = 'Version not found'
}

export interface HistoryDependencies {
  storage: ObjectStorage
  realtime: RealtimeClient
}

// --- Stockage objet ---------------------------------------------------------------------------

/** Texte compressé d'un document, partagé par toutes les versions du projet qui ont ce texte. */
export const historyTextKey = (projectId: string, textSha256: string) =>
  `${projectPrefix(projectId)}history/texts/${textSha256}.gz`

export const versionPrefix = (projectId: string, versionId: string) =>
  `${projectPrefix(projectId)}history/versions/${versionId}/`

const MANIFEST_FILE = 'manifest.json.gz'
const diffKey = (prefix: string, documentId: string) => `${prefix}diffs/${documentId}.json.gz`

async function readObject(storage: ObjectStorage, key: string): Promise<Buffer> {
  return Buffer.concat(await (await storage.read(key)).toArray())
}

async function putGzip(storage: ObjectStorage, key: string, content: string): Promise<void> {
  await storage.putBuffer(key, gzipSync(Buffer.from(content, 'utf8')), 'application/gzip')
}

async function readGzip(storage: ObjectStorage, key: string): Promise<string> {
  return gunzipSync(await readObject(storage, key)).toString('utf8')
}

export async function readManifest(
  storage: ObjectStorage,
  version: ProjectVersion,
): Promise<VersionManifest> {
  const raw = await readGzip(storage, `${version.s3Prefix}${MANIFEST_FILE}`)
  return versionManifestSchema.parse(JSON.parse(raw))
}

export async function readVersionText(
  storage: ObjectStorage,
  projectId: string,
  textSha256: string,
): Promise<string> {
  return readGzip(storage, historyTextKey(projectId, textSha256))
}

/** Texte d'une version, ou null s'il n'est plus dans le stockage. */
export async function readVersionTextIfStored(
  storage: ObjectStorage,
  projectId: string,
  textSha256: string,
): Promise<string | null> {
  const key = historyTextKey(projectId, textSha256)
  if ((await storage.size(key)) === null) return null
  return readGzip(storage, key)
}

/** Diff attribué d'un document dans une version ; null s'il n'a pas changé dans cette version. */
export async function readDiff(
  storage: ObjectStorage,
  version: ProjectVersion,
  documentId: string,
): Promise<DiffSegment[] | null> {
  const key = diffKey(version.s3Prefix, documentId)
  if ((await storage.size(key)) === null) return null
  return diffSegmentSchema.array().parse(JSON.parse(await readGzip(storage, key)))
}

// --- Verrou et sérialisation -------------------------------------------------------------------

/** Verrou consultatif de l'historique d'un projet, libéré à la fin de la transaction. */
export async function lockHistory(trx: TransactionClientContract, projectId: string) {
  await trx.rawQuery('SELECT pg_advisory_xact_lock(hashtextextended(?, 0))', [
    `kaxolax:history:${projectId}`,
  ])
}

export function serializeVersion(version: ProjectVersion): ProjectVersionContract {
  return {
    id: version.id,
    kind: version.kind,
    label: version.label,
    authorIds: version.authorIds,
    changedDocumentIds: version.changedDocumentIds,
    createdAt: version.createdAt.toUTC().toISO() ?? '',
  }
}

/** Nom et photo des auteurs cités (comptes anonymisés compris). */
export async function versionAuthors(ids: Iterable<string>): Promise<VersionAuthor[]> {
  const unique = [...new Set(ids)]
  if (unique.length === 0) return []
  const users = await User.query().whereIn('id', unique).select('id', 'fullName', 'avatarUrl')
  return users.map((user) => ({ id: user.id, name: user.fullName, avatarUrl: user.avatarUrl }))
}

// --- Comparaison de manifestes ---------------------------------------------------------------

type ManifestEntryInput = Omit<VersionEntry, 'status' | 'previousPath'>

/**
 * Changements d'une version par rapport à la précédente : chaque fichier de la version (ajouté,
 * modifié, inchangé ; `previousPath` s'il a été renommé ou déplacé), puis les fichiers supprimés.
 */
export function compareEntries(
  previous: VersionManifest | null,
  current: readonly ManifestEntryInput[],
): VersionEntry[] {
  const before = new Map<string, ManifestEntryInput>()
  for (const document of previous?.documents ?? []) {
    before.set(document.id, { type: 'document', ...document })
  }
  for (const file of previous?.files ?? []) {
    before.set(file.id, {
      type: 'file',
      id: file.id,
      path: file.path,
      sha256: file.sha256,
      sizeBytes: file.sizeBytes,
      mimeType: file.mimeType,
    })
  }
  const entries: VersionEntry[] = current.map((entry) => {
    const old = before.get(entry.id)
    before.delete(entry.id)
    return {
      ...entry,
      status: !old ? 'added' : old.sha256 === entry.sha256 ? 'unchanged' : 'modified',
      previousPath: old && old.path !== entry.path ? old.path : null,
    }
  })
  for (const old of before.values()) entries.push({ ...old, status: 'deleted', previousPath: null })
  return entries
}

function sameManifestShape(previous: VersionManifest, next: Omit<VersionManifest, 'entries'>) {
  const folders = (list: readonly string[]) => [...list].sort().join('\n')
  return (
    previous.mainDocumentId === next.mainDocumentId &&
    folders(previous.folders) === folders(next.folders)
  )
}

// --- Création d'une version ---------------------------------------------------------------------

interface PendingRow {
  id: string | number
  document_id: string
  user_id: string | null
  yjs_update: Buffer
}

export interface CreateVersionOptions {
  kind: VersionKind
  /** Compte qui déclenche la version (compilation, restauration) : annoncé dans l'événement. */
  actorId?: string | null
  /**
   * Version automatique : créée seulement si le projet a changé depuis la dernière version et
   * n'a plus été modifié depuis `idleSeconds` à `now` (revérifié sous le verrou : deux instances
   * qui balaient en même temps ne créent qu'une version).
   */
  due?: { now: DateTime; idleSeconds: number }
}

export interface CreateVersionResult {
  /** Version créée, ou dernière version si rien n'a changé depuis. */
  version: ProjectVersion
  created: boolean
}

/**
 * Crée une version du projet si quelque chose a changé depuis la précédente (arborescence, texte,
 * binaires). Renvoie la version créée, la précédente si rien n'a changé, ou null (projet inconnu,
 * pas encore dû, ou vide sans version).
 */
export async function createVersion(
  deps: HistoryDependencies,
  projectId: string,
  options: CreateVersionOptions,
): Promise<CreateVersionResult | null> {
  // Compilation, restauration : les dernières frappes reçues entrent dans cette version.
  if (!options.due) await deps.realtime.flushUpdates(projectId)
  const result = await db.transaction(async (trx) => {
    await lockHistory(trx, projectId)
    const observed = (await trx
      .from('projects')
      .where('id', projectId)
      .select(trx.raw('updated_at::text AS updated_at'))
      .first()) as { updated_at?: string } | null
    const updatedAt = observed?.updated_at
    if (updatedAt === undefined) return null
    if (options.due && !(await isDue(trx, projectId, options.due))) return null
    const markSynced = async () => {
      await trx
        .from('projects')
        .where('id', projectId)
        .update({
          history_synced_at: trx.raw('?::timestamptz', [updatedAt]),
          history_retry_at: null,
        })
    }

    const project = await Project.query({ client: trx }).where('id', projectId).firstOrFail()
    const tree = await buildTree(projectId, trx)
    const previous = await ProjectVersion.query({ client: trx })
      .where('projectId', projectId)
      .orderBy('createdAt', 'desc')
      .first()
    const previousManifest = previous ? await readManifest(deps.storage, previous) : null
    const previousSha = new Map(previousManifest?.documents.map((d) => [d.id, d.sha256]) ?? [])

    const pending = (await trx
      .from('document_updates')
      .where('project_id', projectId)
      .whereNull('version_id')
      .orderBy('id')
      .select('id', 'document_id', 'user_id', 'yjs_update')
      .forUpdate()) as PendingRow[]
    const windows = new Map<string, PendingRow[]>()
    for (const row of pending) {
      const list = windows.get(row.document_id) ?? []
      list.push(row)
      windows.set(row.document_id, list)
    }
    const stored = new Map(
      (
        (await trx
          .from('documents')
          .where('project_id', projectId)
          .select('id', 'yjs_state', 'content_sha256')) as {
          id: string
          yjs_state: Buffer | null
          content_sha256: string | null
        }[]
      ).map((row) => [row.id, row]),
    )

    const documents: VersionManifest['documents'] = []
    const texts = new Map<string, string>()
    const diffs = new Map<string, DiffSegment[]>()
    const compactions: { documentId: string; removeIds: (string | number)[]; state: Uint8Array }[] =
      []
    for (const entry of tree.documents) {
      const window = windows.get(entry.id) ?? []
      const known = previousSha.get(entry.id)
      const row = stored.get(entry.id)
      if (window.length === 0 && known !== undefined && row?.content_sha256 === known) {
        documents.push({ id: entry.id, path: entry.path, sha256: known })
        continue
      }
      const base = (await trx
        .from('document_updates')
        .where('document_id', entry.id)
        .whereNotNull('version_id')
        .orderBy('id')
        .select('id', 'yjs_update')) as { id: string | number; yjs_update: Buffer }[]
      const updates: AttributedUpdate[] = window.map((update) => ({
        authorId: update.user_id,
        update: new Uint8Array(update.yjs_update),
      }))
      const replay = replayWithAttribution(
        base.map((update) => new Uint8Array(update.yjs_update)),
        updates,
        row?.yjs_state ? new Uint8Array(row.yjs_state) : null,
      )
      const textSha = sha256(replay.text)
      documents.push({ id: entry.id, path: entry.path, sha256: textSha })
      texts.set(textSha, replay.text)
      if (textSha !== known) diffs.set(entry.id, replay.segments)
      compactions.push({
        documentId: entry.id,
        removeIds: [...base.map((update) => update.id), ...window.map((update) => update.id)],
        state: replay.state,
      })
    }

    const fileRows = await File.query({ client: trx })
      .where('projectId', projectId)
      .select('id', 's3Key', 'sha256')
    const fileById = new Map(fileRows.map((file) => [file.id, file]))
    const files: VersionManifest['files'] = tree.files.flatMap((entry) => {
      const file = fileById.get(entry.id)
      return file
        ? [
            {
              id: entry.id,
              path: entry.path,
              sha256: file.sha256,
              sizeBytes: entry.sizeBytes,
              mimeType: entry.mimeType,
              s3Key: file.s3Key,
            },
          ]
        : []
    })
    const shape = {
      v: VERSION_MANIFEST_VERSION,
      mainDocumentId: project.mainDocumentId,
      folders: tree.folders.map((folder) => folder.path),
      documents,
      files,
    } as const
    const entries = compareEntries(previousManifest, [
      ...documents.map((document) => ({ type: 'document' as const, ...document })),
      ...files.map((file) => ({
        type: 'file' as const,
        id: file.id,
        path: file.path,
        sha256: file.sha256,
        sizeBytes: file.sizeBytes,
        mimeType: file.mimeType,
      })),
    ])
    const changed =
      !previousManifest ||
      !sameManifestShape(previousManifest, shape) ||
      entries.some((entry) => entry.status !== 'unchanged' || entry.previousPath !== null)
    if (!changed) {
      await markSynced()
      return previous ? { version: previous, created: false } : null
    }
    if (!previousManifest && entries.length === 0 && shape.folders.length === 0) {
      await markSynced()
      return null
    }

    const versionId = randomUUID()
    const prefix = versionPrefix(projectId, versionId)
    const manifest: VersionManifest = { ...shape, entries }
    // Textes déjà stockés pour une autre version du projet : pas réécrits.
    const knownTexts = new Set(
      (
        (await trx
          .from('version_documents')
          .join('project_versions', 'project_versions.id', 'version_documents.version_id')
          .where('project_versions.project_id', projectId)
          .whereIn('version_documents.sha256', [...texts.keys()])
          .distinct('version_documents.sha256')) as { sha256: string }[]
      ).map((row) => row.sha256),
    )
    for (const [textSha, text] of texts) {
      if (!knownTexts.has(textSha))
        await putGzip(deps.storage, historyTextKey(projectId, textSha), text)
    }
    for (const [documentId, segments] of diffs) {
      await putGzip(deps.storage, diffKey(prefix, documentId), JSON.stringify(segments))
    }
    await putGzip(deps.storage, `${prefix}${MANIFEST_FILE}`, JSON.stringify(manifest))

    // Dates strictement croissantes : l'ordre des versions d'un projet ne dépend pas de l'horloge.
    const now = DateTime.utc()
    const createdAt =
      previous && previous.createdAt >= now ? previous.createdAt.plus({ milliseconds: 1 }) : now
    const version = await ProjectVersion.create(
      {
        id: versionId,
        projectId,
        kind: options.kind,
        authorIds: [
          ...new Set(pending.flatMap((row) => (row.user_id === null ? [] : [row.user_id]))),
        ],
        changedDocumentIds: entries
          .filter((entry) => entry.type === 'document' && entry.status !== 'unchanged')
          .map((entry) => entry.id),
        s3Prefix: prefix,
        label: null,
        createdAt,
      },
      { client: trx },
    )
    // Textes cités par la version : ses documents, et ceux qu'elle montre supprimés (le diff
    // d'une entrée supprimée lit son dernier texte, qui doit survivre à la purge des versions
    // précédentes).
    const citedTexts = [
      ...documents.map((document) => ({ documentId: document.id, sha256: document.sha256 })),
      ...entries
        .filter((entry) => entry.type === 'document' && entry.status === 'deleted')
        .map((entry) => ({ documentId: entry.id, sha256: entry.sha256 })),
    ]
    for (let index = 0; index < citedTexts.length; index += 500) {
      await VersionDocument.createMany(
        citedTexts.slice(index, index + 500).map((cited) => ({ versionId, ...cited })),
        { client: trx },
      )
    }
    for (let index = 0; index < files.length; index += 500) {
      await VersionFile.createMany(
        files
          .slice(index, index + 500)
          .map((file) => ({ versionId, fileId: file.id, sha256: file.sha256 })),
        { client: trx },
      )
    }
    // Journal compacté : une ligne par document recalculé, base de la version suivante.
    for (const compaction of compactions) {
      await trx.from('document_updates').whereIn('id', compaction.removeIds).delete()
      await trx
        .insertQuery()
        .table('document_updates')
        .insert({
          project_id: projectId,
          document_id: compaction.documentId,
          user_id: null,
          yjs_update: Buffer.from(compaction.state),
          version_id: versionId,
        })
    }
    await markSynced()
    return { version, created: true }
  })
  if (result?.created) {
    await deps.realtime.publishProjectEvent(projectId, {
      type: 'version.created',
      versionId: result.version.id,
      kind: result.version.kind,
      actorId: options.actorId ?? null,
    })
  }
  return result
}

/**
 * Version automatique due : projet modifié depuis la dernière version (ou jamais vérifié), sans
 * modification depuis `idleSeconds`, ni mise à jour Yjs journalisée depuis.
 */
async function isDue(
  client: TransactionClientContract,
  projectId: string,
  due: { now: DateTime; idleSeconds: number },
): Promise<boolean> {
  const cutoff = due.now.minus({ seconds: due.idleSeconds }).toJSDate()
  const row = (await client
    .from('projects')
    .where('id', projectId)
    .where('updated_at', '<=', cutoff)
    .where((query) => {
      void query.whereNull('history_synced_at').orWhereRaw('updated_at > history_synced_at')
    })
    .whereNotExists((query) => {
      void query
        .from('document_updates')
        .whereRaw('document_updates.project_id = projects.id')
        .whereNull('version_id')
        .where('created_at', '>', cutoff)
    })
    .select('id')
    .first()) as { id: string } | null
  return row !== null
}

/**
 * Projets dont une version automatique est due (au plus `limit`, les plus anciens d'abord), hors
 * projets en attente d'un nouvel essai après un échec (`markVersionRetry`) : ils ne monopolisent
 * pas le balayage.
 */
export async function dueProjectIds(
  due: { now: DateTime; idleSeconds: number },
  limit = 50,
): Promise<string[]> {
  const cutoff = due.now.minus({ seconds: due.idleSeconds }).toJSDate()
  const rows = (await db
    .from('projects')
    .where('updated_at', '<=', cutoff)
    .where((query) => {
      void query.whereNull('history_retry_at').orWhere('history_retry_at', '<=', due.now.toJSDate())
    })
    .where((query) => {
      void query.whereNull('history_synced_at').orWhereRaw('updated_at > history_synced_at')
    })
    .whereNotExists((query) => {
      void query
        .from('document_updates')
        .whereRaw('document_updates.project_id = projects.id')
        .whereNull('version_id')
        .where('created_at', '>', cutoff)
    })
    .orderBy('updated_at')
    .limit(limit)
    .select('id')) as { id: string }[]
  return rows.map((row) => row.id)
}

/** Échec d'une version automatique : le projet attend `at` avant un nouvel essai. */
export async function markVersionRetry(projectId: string, at: DateTime): Promise<void> {
  await db.from('projects').where('id', projectId).update({ history_retry_at: at.toJSDate() })
}

/**
 * Version d'une compilation manuelle ou d'une restauration, au mieux : une erreur est journalisée
 * et n'empêche pas la compilation.
 */
export async function createVersionSafely(
  deps: HistoryDependencies,
  projectId: string,
  options: CreateVersionOptions,
): Promise<CreateVersionResult | null> {
  try {
    return await createVersion(deps, projectId, options)
  } catch (error) {
    logger.error({ err: error, projectId, kind: options.kind }, 'could not create a version')
    return null
  }
}

// --- Binaires et purge ------------------------------------------------------------------------

/**
 * Supprime les objets de fichiers binaires retirés de l'arborescence, sauf ceux qu'une version
 * référence encore (ils partent avec la dernière version qui les cite, voir `purgeProjectHistory`)
 * ou revenus dans l'arborescence (restauration). Sous le verrou de l'historique : une version en
 * cours de création qui les référence est validée avant la vérification.
 */
export async function releaseFileObjects(
  storage: ObjectStorage,
  projectId: string,
  files: readonly { id: string; s3Key: string }[],
): Promise<void> {
  if (files.length === 0) return
  await db.transaction(async (trx) => {
    await lockHistory(trx, projectId)
    const ids = files.map((file) => file.id)
    const kept = await keptFileIds(trx, projectId, ids)
    await storage.delete(files.filter((file) => !kept.has(file.id)).map((file) => file.s3Key))
  })
}

/** Fichiers encore référencés par une version du projet, ou présents dans l'arborescence. */
async function keptFileIds(
  trx: TransactionClientContract,
  projectId: string,
  ids: readonly string[],
): Promise<Set<string>> {
  if (ids.length === 0) return new Set()
  const referenced = (await trx
    .from('version_files')
    .join('project_versions', 'project_versions.id', 'version_files.version_id')
    .where('project_versions.project_id', projectId)
    .whereIn('version_files.file_id', [...ids])
    .distinct('version_files.file_id as id')) as { id: string }[]
  const live = (await trx
    .from('files')
    .where('project_id', projectId)
    .whereIn('id', [...ids])
    .select('id')) as { id: string }[]
  return new Set([...referenced, ...live].map((row) => row.id))
}

/**
 * Purge l'historique d'un projet selon la conservation de son plan (`retentionDays`, null :
 * rien) : versions sans label plus anciennes, jamais la plus récente (base de la suivante).
 * Renvoie le nombre de versions purgées.
 *
 * Deux temps : les lignes sont supprimées et validées d'abord, puis, sous un nouveau verrou, les
 * textes et binaires que plus rien ne référence (revérifié à ce moment) quittent le stockage avec
 * les dossiers des versions purgées. Un échec du stockage laisse au pire des objets orphelins,
 * jamais une version qui cite un objet supprimé : `createVersion` ne réécrit un texte que s'il
 * n'est plus référencé.
 */
export async function purgeProjectHistory(
  storage: ObjectStorage,
  projectId: string,
  retentionDays: number | null,
  now: DateTime = DateTime.utc(),
): Promise<number> {
  if (retentionDays === null) return 0
  const cutoff = now.minus({ days: retentionDays })
  const purged = await db.transaction(async (trx) => {
    await lockHistory(trx, projectId)
    const latest = await ProjectVersion.query({ client: trx })
      .where('projectId', projectId)
      .orderBy('createdAt', 'desc')
      .select('id')
      .first()
    if (!latest) return null
    const candidates = (
      await ProjectVersion.query({ client: trx })
        .where('projectId', projectId)
        .whereNull('label')
        .where('createdAt', '<', cutoff.toJSDate())
        .whereNot('id', latest.id)
        .select('id')
    ).map((version) => version.id)
    if (candidates.length === 0) return null
    const texts = (await trx
      .from('version_documents')
      .whereIn('version_id', candidates)
      .distinct('sha256')) as { sha256: string }[]
    const fileIds = (await trx
      .from('version_files')
      .whereIn('version_id', candidates)
      .distinct('file_id')) as { file_id: string }[]
    // Label revérifié par la suppression : une version nommée entre-temps n'est jamais purgée.
    const deleted = (await trx
      .from('project_versions')
      .whereIn('id', candidates)
      .whereNull('label')
      .delete()
      .returning(['id', 's3_prefix'])) as { id: string; s3_prefix: string }[]
    if (deleted.length === 0) return null
    return {
      count: deleted.length,
      prefixes: deleted.map((row) => row.s3_prefix),
      texts: texts.map((row) => row.sha256),
      fileIds: fileIds.map((row) => row.file_id),
    }
  })
  if (purged === null) return 0

  await db.transaction(async (trx) => {
    await lockHistory(trx, projectId)
    const stillUsedTexts = new Set(
      purged.texts.length === 0
        ? []
        : (
            (await trx
              .from('version_documents')
              .join('project_versions', 'project_versions.id', 'version_documents.version_id')
              .where('project_versions.project_id', projectId)
              .whereIn('version_documents.sha256', purged.texts)
              .distinct('version_documents.sha256')) as { sha256: string }[]
          ).map((row) => row.sha256),
    )
    const keptFiles = await keptFileIds(trx, projectId, purged.fileIds)
    await storage.delete([
      ...purged.texts
        .filter((textSha) => !stillUsedTexts.has(textSha))
        .map((textSha) => historyTextKey(projectId, textSha)),
      ...purged.fileIds
        .filter((fileId) => !keptFiles.has(fileId))
        .map((fileId) => fileKey(projectId, fileId)),
    ])
  })
  for (const prefix of purged.prefixes) await storage.deletePrefix(prefix)
  return purged.count
}

/** Restauration d'un document supprimé : son état initial, attribué à `userId`. */
export function restoredDocumentState(text: string): Buffer {
  return Buffer.from(createDocumentState(text))
}
