import { PassThrough, Readable } from 'node:stream'
import {
  type DiffSegment,
  type DocumentDiffResponse,
  restoreVersionInputSchema,
  updateVersionInputSchema,
  type VersionDetail,
  versionListQuerySchema,
  type VersionListResponse,
} from '@kaxolax/contracts'
import { inject } from '@adonisjs/core'
import type { HttpContext } from '@adonisjs/core/http'
import encryption from '@adonisjs/core/services/encryption'
import logger from '@adonisjs/core/services/logger'
import yazl from 'yazl'
import { DownloadLinkExpiredException } from '#controllers/exports_controller'
import ProjectVersion from '#models/project_version'
import User from '#models/user'
import ObjectStorage, { contentDisposition } from '#services/object_storage'
import { projectFor } from '#services/project_access'
import RealtimeClient from '#services/realtime_client'
import { historyRetention } from '#services/entitlements'
import {
  findVersion,
  restoreVersion,
  VersionEntryNotFoundException,
} from '#services/history_restore'
import {
  type HistoryDependencies,
  readDiff,
  readManifest,
  readVersionText,
  readVersionTextIfStored,
  serializeVersion,
  versionAuthors,
} from '#services/history_service'
import { validateWithZod } from '#validators/zod'

/** Lien de téléchargement d'une version, chiffré par APP_KEY (comme celui du projet). */
const DOWNLOAD_PURPOSE = 'version-download'
const DOWNLOAD_TTL_SECONDS = 60

/**
 * Historique du projet (contrats dans `packages/contracts/src/history.ts`) : liste des versions,
 * détail, diff attribué d'un document, aperçu d'un binaire, label, restauration, zip d'une
 * version. Lecture pour tout membre ; label et restauration avec la permission `edit` (editor et
 * owner).
 */
@inject()
export default class HistoryController {
  constructor(
    private readonly realtime: RealtimeClient,
    private readonly storage: ObjectStorage,
  ) {}

  private get deps(): HistoryDependencies {
    return { storage: this.storage, realtime: this.realtime }
  }

  async index({ params, request, auth }: HttpContext): Promise<VersionListResponse> {
    const user = auth.getUserOrFail()
    const { project } = await projectFor(user, String(params.id), 'read')
    const query = validateWithZod(versionListQuerySchema, request.qs())
    const builder = ProjectVersion.query()
      .where('projectId', project.id)
      .orderBy('createdAt', 'desc')
      .limit(query.limit + 1)
    if (query.before !== undefined) {
      const cursor = await findVersion(project.id, query.before)
      void builder.where('createdAt', '<', cursor.createdAt.toJSDate())
    }
    const rows = await builder
    const page = rows.slice(0, query.limit)
    return {
      versions: page.map(serializeVersion),
      authors: await versionAuthors(page.flatMap((version) => version.authorIds)),
      nextCursor: rows.length > query.limit ? (page.at(-1)?.id ?? null) : null,
      // Conservation du plan du propriétaire (tâche 12) ; les versions avec label restent.
      retentionDays: (await historyRetention({ id: project.ownerId }, user)).days,
    }
  }

  async show({ params, auth }: HttpContext): Promise<VersionDetail> {
    const { project } = await projectFor(auth.getUserOrFail(), String(params.id), 'read')
    const version = await findVersion(project.id, String(params.versionId))
    const manifest = await readManifest(this.storage, version)
    return {
      version: serializeVersion(version),
      authors: await versionAuthors(version.authorIds),
      folders: manifest.folders,
      mainDocumentId: manifest.mainDocumentId,
      entries: manifest.entries,
    }
  }

  /**
   * Diff d'un document dans la version, coloré par auteur. Un document inchangé est renvoyé tel
   * quel (un seul segment `equal`), un document supprimé comme entièrement supprimé.
   */
  async diff({ params, auth }: HttpContext): Promise<DocumentDiffResponse> {
    const { project } = await projectFor(auth.getUserOrFail(), String(params.id), 'read')
    const version = await findVersion(project.id, String(params.versionId))
    const manifest = await readManifest(this.storage, version)
    const entry = manifest.entries.find(
      (candidate) => candidate.type === 'document' && candidate.id === String(params.documentId),
    )
    if (!entry) throw new VersionEntryNotFoundException()
    let segments: DiffSegment[] | null =
      entry.status === 'added' || entry.status === 'modified'
        ? await readDiff(this.storage, version, entry.id)
        : null
    if (!segments) {
      // Entrée supprimée dont le texte a disparu du stockage : montrée vide plutôt qu'en erreur.
      const text =
        entry.status === 'deleted'
          ? ((await readVersionTextIfStored(this.storage, project.id, entry.sha256)) ?? '')
          : await readVersionText(this.storage, project.id, entry.sha256)
      const op =
        entry.status === 'deleted' ? 'delete' : entry.status === 'added' ? 'insert' : 'equal'
      segments = text === '' ? [] : [{ op, text, authorId: null }]
    }
    return {
      documentId: entry.id,
      path: entry.path,
      previousPath: entry.previousPath,
      status: entry.status,
      segments,
    }
  }

  /** URL présignée (lecture) d'un binaire de la version : aperçu d'une image. */
  async fileUrl({ params, auth }: HttpContext) {
    const { project } = await projectFor(auth.getUserOrFail(), String(params.id), 'read')
    const version = await findVersion(project.id, String(params.versionId))
    const manifest = await readManifest(this.storage, version)
    const file = manifest.files.find((candidate) => candidate.id === String(params.fileId))
    if (!file) throw new VersionEntryNotFoundException()
    const name = file.path.split('/').at(-1) ?? file.path
    return {
      url: await this.storage.presignDownload(file.s3Key, name, {
        mode: 'inline',
        contentType: file.mimeType,
      }),
    }
  }

  async update({ params, request, auth }: HttpContext) {
    const input = validateWithZod(updateVersionInputSchema, request.body())
    const { project } = await projectFor(auth.getUserOrFail(), String(params.id), 'edit')
    const version = await findVersion(project.id, String(params.versionId))
    version.label = input.label
    await version.save()
    return { version: serializeVersion(version) }
  }

  async restore({ params, request, auth }: HttpContext) {
    const input = validateWithZod(restoreVersionInputSchema, request.body())
    return restoreVersion(
      this.deps,
      auth.getUserOrFail(),
      String(params.id),
      String(params.versionId),
      input,
    )
  }

  async download({ params, auth, response }: HttpContext) {
    await this.stream(auth.getUserOrFail(), String(params.id), String(params.versionId), response)
  }

  /** Lien court (60 s) : téléchargement par une simple navigation (voir ExportsController). */
  async downloadUrl({ params, auth }: HttpContext) {
    const user = auth.getUserOrFail()
    const { project } = await projectFor(user, String(params.id), 'read')
    const version = await findVersion(project.id, String(params.versionId))
    const token = encryption.encrypt(
      { userId: user.id, projectId: project.id, versionId: version.id },
      `${String(DOWNLOAD_TTL_SECONDS)}s`,
      DOWNLOAD_PURPOSE,
    )
    return {
      url: `/api/v1/version-downloads/${encodeURIComponent(token)}`,
      expiresAt: new Date(Date.now() + DOWNLOAD_TTL_SECONDS * 1000).toISOString(),
    }
  }

  /** Téléchargement par lien : le rôle est revérifié au moment du téléchargement. */
  async downloadWithLink({ params, response }: HttpContext) {
    const claims = encryption.decrypt<{
      userId?: unknown
      projectId?: unknown
      versionId?: unknown
    }>(String(params.token), DOWNLOAD_PURPOSE)
    if (
      typeof claims?.userId !== 'string' ||
      typeof claims.projectId !== 'string' ||
      typeof claims.versionId !== 'string'
    ) {
      throw new DownloadLinkExpiredException()
    }
    const user = await User.query()
      .where('id', claims.userId)
      .whereNull('deletedAt')
      .whereNull('bannedAt')
      .first()
    if (!user) throw new DownloadLinkExpiredException()
    await this.stream(user, claims.projectId, claims.versionId, response)
  }

  /** Zip de la version : textes et binaires à leur chemin, dossiers vides compris. */
  private async stream(
    user: User,
    projectId: string,
    versionId: string,
    response: HttpContext['response'],
  ) {
    const { project } = await projectFor(user, projectId, 'read')
    const version = await findVersion(project.id, versionId)
    const manifest = await readManifest(this.storage, version)
    const texts = new Map<string, string>()
    for (const document of manifest.documents) {
      if (!texts.has(document.sha256)) {
        texts.set(document.sha256, await readVersionText(this.storage, project.id, document.sha256))
      }
    }

    const zip = new yazl.ZipFile()
    const occupied = [
      ...manifest.documents.map((document) => document.path),
      ...manifest.files.map((file) => file.path),
      ...manifest.folders,
    ]
    for (const folder of manifest.folders) {
      if (!occupied.some((path) => path.startsWith(`${folder}/`))) zip.addEmptyDirectory(folder)
    }
    for (const document of manifest.documents) {
      zip.addBuffer(Buffer.from(texts.get(document.sha256) ?? '', 'utf8'), document.path)
    }
    for (const file of manifest.files) {
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
    zip.on('error', (error: Error) => {
      logger.error({ err: error, projectId: project.id, versionId }, 'version zip failed')
      output.destroy(error)
    })
    const stamp = version.createdAt.toUTC().toFormat("yyyy-LL-dd'T'HHmm")
    response.header('content-type', 'application/zip')
    response.header(
      'content-disposition',
      contentDisposition('attachment', `${project.name} (${version.label ?? stamp}).zip`),
    )
    response.header('cache-control', 'no-store')
    response.stream(output)
  }
}
