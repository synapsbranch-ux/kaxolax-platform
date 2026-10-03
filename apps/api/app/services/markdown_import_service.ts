import { createHash, randomUUID } from 'node:crypto'
import {
  type ConvertCitations,
  type ConvertDocumentClass,
  convertDocumentClassSchema,
  type ConvertRequest,
  type ConvertResult,
  type ImportedMedia,
  loadedPackageNames,
  MAX_CLEANUP_MARKDOWN_BYTES,
  MAX_CONVERT_MEDIA_PATHS,
  MAX_MARKDOWN_BYTES,
  MAX_TREE_CHANGES,
  type MarkdownCleanupResult,
  type MarkdownImportBody,
  type MarkdownImportPreambleResult,
  type MarkdownImportResponse,
  missingRequirements,
  pandocRequirements,
  stripLatexComments,
  type TreeChange,
} from '@kaxolax/contracts'
import { Exception } from '@adonisjs/core/exceptions'
import logger from '@adonisjs/core/services/logger'
import db from '@adonisjs/lucid/services/db'
import { type TransactionClientContract } from '@adonisjs/lucid/types/database'
import compileConfig from '#config/compile'
import File from '#models/file'
import Folder from '#models/folder'
import type Project from '#models/project'
import type User from '#models/user'
import type ClaudeService from '#services/claude/claude_service'
import type CompileGateway from '#services/compile_gateway'
import type CompileWorkerClient from '#services/compile_worker'
import { reserveCompiler } from '#services/compiler_quota'
import { cleanupLatex, latexProblem } from '#services/markdown_cleanup'
import type ObjectStorage from '#services/object_storage'
import { fileKey } from '#services/object_storage'
import { assertProjectStorageAvailable } from '#services/plan_enforcement'
import { projectFor } from '#services/project_access'
import { type ProjectContent, projectContent } from '#services/project_content'
import type RealtimeClient from '#services/realtime_client'
import {
  assertNameAvailable,
  createDocument,
  createFile,
  EntityNotFoundException,
  NameTakenException,
  touchProject,
} from '#services/tree_service'

/** Conversion en cours pour l'utilisateur, ou trop de conversions simultanées. */
export class ConvertBusyException extends Exception {
  static override status = 429
  static override code = 'E_CONVERT_BUSY'
  static override message = 'A Markdown conversion is already running, try again when it is done'
}

/** Le document source n'est pas un fichier Markdown. */
export class NotMarkdownException extends Exception {
  static override status = 422
  static override code = 'E_NOT_MARKDOWN'
  static override message = 'Only .md and .markdown documents can be converted'
}

/** Markdown trop long (pandoc, ou nettoyage par l'IA). */
export class MarkdownTooLargeException extends Exception {
  static override status = 422
  static override code = 'E_MARKDOWN_TOO_LARGE'
  static override message = 'This Markdown is too large to convert'
}

/** LaTeX à écrire non conforme (texte validé dans l'aperçu, ou résultat trop gros). */
export class InvalidConvertedLatexException extends Exception {
  static override status = 422
  static override code = 'E_INVALID_LATEX'
  static override message = 'The converted LaTeX cannot be written'
}

/** Le Markdown a changé depuis l'aperçu dont le texte validé est issu. */
export class SourceChangedException extends Exception {
  static override status = 409
  static override code = 'E_SOURCE_CHANGED'
  static override message = 'The Markdown changed since the preview, preview it again'
}

/** Conversions en cours au plus par utilisateur, par instance de l'API. */
export const MAX_CONVERSIONS_PER_USER = 2

const runningPerUser = new Map<string, number>()

export interface MarkdownImportDependencies {
  gateway: CompileGateway
  worker: CompileWorkerClient
  realtime: RealtimeClient
  storage: ObjectStorage
  claude: ClaudeService
}

const MARKDOWN_EXTENSION = /\.(?:md|markdown)$/i
const sha256 = (content: string | Buffer) => createHash('sha256').update(content).digest('hex')
const bytes = (text: string) => Buffer.byteLength(text, 'utf8')

/** Dossier d'un chemin du projet ('' à la racine). */
export function dirname(path: string): string {
  const slash = path.lastIndexOf('/')
  return slash === -1 ? '' : path.slice(0, slash)
}

function basename(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1)
}

/** Classe du document principal si pandoc la connaît (titres `\chapter` d'un `report`…). */
export function documentClassOf(text: string | null): ConvertDocumentClass | null {
  if (text === null) return null
  const match = /\\documentclass\s*(?:\[[^\]]*\])?\s*\{([^}]+)\}/.exec(stripLatexComments(text))
  const parsed = convertDocumentClassSchema.safeParse(match?.[1]?.trim())
  return parsed.success ? parsed.data : null
}

/** Commandes des citations : biblatex si le document principal le charge, sinon natbib. */
export function citationsOf(mainText: string | null): ConvertCitations {
  return mainText !== null && loadedPackageNames(mainText)?.has('biblatex') === true
    ? 'biblatex'
    : 'natbib'
}

/** Clés des entrées des `.bib` (`@article{clé,` ; `@string`, `@preamble`, `@comment` exclus). */
export function bibKeys(texts: string[]): Set<string> {
  const keys = new Set<string>()
  for (const text of texts) {
    for (const match of text.matchAll(/@\s*([A-Za-z]+)\s*[{(]\s*([^,\s{}()]+)\s*,/g)) {
      const type = (match[1] ?? '').toLowerCase()
      if (type === 'string' || type === 'preamble' || type === 'comment') continue
      if (match[2] !== undefined) keys.add(match[2])
    }
  }
  return keys
}

/** Clés citées au plus dans un avertissement. */
const MAX_LISTED_KEYS = 20

/** Avertissement si des citations n'ont pas d'entrée dans les `.bib` du projet. */
export function citationWarning(citations: string[], bibTexts: string[]): string | null {
  if (citations.length === 0) return null
  const list = (keys: string[]) =>
    keys.slice(0, MAX_LISTED_KEYS).join(', ') + (keys.length > MAX_LISTED_KEYS ? ', …' : '')
  if (bibTexts.length === 0) {
    return `Citations need a .bib file in the project: ${list(citations)}`
  }
  const known = bibKeys(bibTexts)
  const missing = citations.filter((key) => !known.has(key))
  return missing.length === 0
    ? null
    : `Citation keys not found in the .bib files of the project: ${list(missing)}`
}

/** Chemin du `.tex` créé par défaut : la source avec l'extension `.tex`, ou `imported.tex`. */
export function defaultTargetPath(sourcePath: string | null): string {
  return sourcePath === null ? 'imported.tex' : sourcePath.replace(MARKDOWN_EXTENSION, '.tex')
}

/** Chemins occupés du projet (dossiers, documents, fichiers), pour les conflits de nom. */
function occupiedPaths(content: ProjectContent) {
  return {
    folders: new Set(content.folders),
    entries: new Map<string, string | null>([
      ...content.documents.map((document) => [document.path, null] as const),
      ...content.files.map((file) => [file.path, file.sha256] as const),
    ]),
  }
}

/** Un dossier parent de `path` est un document ou un fichier : le chemin est impossible. */
function blockedByEntry(path: string, entries: Map<string, string | null>): boolean {
  const segments = path.split('/')
  for (let index = 1; index < segments.length; index++) {
    if (entries.has(segments.slice(0, index).join('/'))) return true
  }
  return false
}

/**
 * Crée au besoin les dossiers de `path` (dans une transaction qui a verrouillé le projet) ;
 * renvoie l'identifiant du dernier, null à la racine. Un nom pris par un document ou un fichier :
 * 409 `E_NAME_TAKEN`.
 */
async function ensureFolders(
  trx: TransactionClientContract,
  projectId: string,
  path: string,
  created: Folder[],
): Promise<string | null> {
  let parentId: string | null = null
  if (path === '') return parentId
  for (const name of path.split('/')) {
    const query = Folder.query({ client: trx }).where({ projectId, name })
    if (parentId === null) void query.whereNull('parentId')
    else void query.where('parentId', parentId)
    const existing: Folder | null = await query.first()
    if (existing) {
      parentId = existing.id
      continue
    }
    await assertNameAvailable(trx, projectId, parentId, name)
    const folder: Folder = await Folder.create({ projectId, parentId, name }, { client: trx })
    created.push(folder)
    parentId = folder.id
  }
  return parentId
}

/** Image extraite à ranger : contenu décodé, empreinte recalculée (rien n'est pris sur parole). */
interface PendingMedia {
  path: string
  contentType: ImportedMedia['contentType']
  content: Buffer
  sha256: string
  /** Fichier déjà présent avec ce contenu (rien à écrire). */
  existingSha: string | null
}

/** Appel au sandbox : gateway (synchrone) ou conteneur Cloudflare du projet (compté). */
async function runConversion(
  deps: MarkdownImportDependencies,
  user: User,
  request: ConvertRequest,
): Promise<ConvertResult> {
  if (compileConfig.backend === 'cloudflare') {
    await reserveCompiler(user.id, request.projectId)
    return deps.worker.convert(request)
  }
  return deps.gateway.convert(request)
}

/**
 * Importe du Markdown (voir `markdownImportBodySchema`) : au plus `MAX_CONVERSIONS_PER_USER`
 * conversions en cours par utilisateur (429 `E_CONVERT_BUSY`), pandoc dans le sandbox, nettoyage
 * facultatif par l'IA, puis (hors aperçu) dossiers, images extraites et fichier `.tex` créés dans
 * une transaction (stockage du plan du propriétaire vérifié), événement `tree.changed` ensuite.
 */
export async function importMarkdown(
  deps: MarkdownImportDependencies,
  user: User,
  projectId: string,
  body: MarkdownImportBody,
): Promise<MarkdownImportResponse> {
  const { project } = await projectFor(user, projectId, 'edit')
  const count = runningPerUser.get(user.id) ?? 0
  if (count >= MAX_CONVERSIONS_PER_USER) throw new ConvertBusyException()
  runningPerUser.set(user.id, count + 1)
  try {
    return await runImport(deps, user, project, body)
  } finally {
    const left = (runningPerUser.get(user.id) ?? 1) - 1
    if (left <= 0) runningPerUser.delete(user.id)
    else runningPerUser.set(user.id, left)
  }
}

async function runImport(
  deps: MarkdownImportDependencies,
  user: User,
  project: Project,
  body: MarkdownImportBody,
): Promise<MarkdownImportResponse> {
  const projectId = project.id
  const started = performance.now()
  const output = body.output ?? 'file'
  const preambleMode = body.preamble ?? 'main'
  const mode = preambleMode === 'embedded' ? 'document' : 'fragment'
  const dryRun = body.dryRun === true
  const cleanup = body.cleanup === true

  if (cleanup) {
    if (body.markdown !== undefined && bytes(body.markdown) > MAX_CLEANUP_MARKDOWN_BYTES) {
      throw new MarkdownTooLargeException('This Markdown is too large to be cleaned up by the AI')
    }
    // IA configurée et activée (projet, workspace) avant d'occuper le sandbox.
    await deps.claude.assertUsable({ id: projectId })
  }

  const content = await projectContent(deps.realtime, projectId)
  let markdown: string
  let sourcePath: string
  let sourceDocument: string | null = null
  if (body.documentId === undefined) {
    markdown = body.markdown ?? ''
    // Images relatives du texte collé : depuis la racine du projet.
    sourcePath = 'pasted.md'
  } else {
    const source = content.documents.find((document) => document.id === body.documentId)
    if (!source) throw new EntityNotFoundException('Document not found')
    if (!MARKDOWN_EXTENSION.test(source.path)) throw new NotMarkdownException()
    markdown = source.content
    sourcePath = source.path
    sourceDocument = source.path
  }
  if (bytes(markdown) > MAX_MARKDOWN_BYTES) throw new MarkdownTooLargeException()
  const sourceSha256 = sha256(markdown)
  // Texte validé dans un aperçu d'une autre version du Markdown : il en perdrait les changements.
  if (
    body.latex !== undefined &&
    body.sourceSha256 !== undefined &&
    body.sourceSha256 !== sourceSha256
  ) {
    throw new SourceChangedException()
  }
  if (cleanup && bytes(markdown) > MAX_CLEANUP_MARKDOWN_BYTES) {
    throw new MarkdownTooLargeException('This Markdown is too large to be cleaned up by the AI')
  }

  const main = content.documents.find((document) => document.id === project.mainDocumentId)
  const targetPath =
    body.targetPath ??
    (output === 'insert' ? (main?.path ?? 'main.tex') : defaultTargetPath(sourceDocument))
  const occupied = occupiedPaths(content)
  if (output === 'file') {
    // Conflit signalé dès l'aperçu : l'utilisateur choisit un autre nom avant de convertir.
    if (
      occupied.entries.has(targetPath) ||
      occupied.folders.has(targetPath) ||
      blockedByEntry(targetPath, occupied.entries)
    ) {
      throw new NameTakenException(`${targetPath} already exists`)
    }
  }

  // Images : relatives au document qui compile (principal, ou le fichier autonome lui-même).
  const graphicsDir =
    preambleMode === 'embedded' || main === undefined ? dirname(targetPath) : dirname(main.path)
  const request: ConvertRequest = {
    projectId,
    sourcePath,
    targetPath,
    graphicsDir,
    markdown,
    media: content.files.map((file) => file.path).slice(0, MAX_CONVERT_MEDIA_PATHS),
    options: {
      mode,
      documentClass:
        body.documentClass ??
        documentClassOf(preambleMode === 'embedded' ? null : (main?.content ?? null)) ??
        'article',
      // Fragment : titres `#` en `\section` par défaut, quelle que soit la classe.
      topLevelDivision: body.topLevelDivision ?? (mode === 'fragment' ? 'section' : 'default'),
      ...(body.numberSections === undefined ? {} : { numberSections: body.numberSections }),
      citations: body.citations ?? citationsOf(main?.content ?? null),
      ...(body.rawLatex === undefined ? {} : { rawLatex: body.rawLatex }),
    },
  }
  const result = await runConversion(deps, user, request)

  let latex = result.latex
  let cleanupResult: MarkdownCleanupResult | null = null
  let pandocLatex: string | null = null
  if (cleanup) {
    const outcome = await cleanupLatex(deps.claude, user, { id: projectId }, latex, mode)
    cleanupResult = { applied: outcome.applied, warning: outcome.warning, credits: outcome.credits }
    if (outcome.applied) {
      pandocLatex = latex
      latex = outcome.latex
    }
  }
  if (body.latex !== undefined) {
    // Texte validé dans l'aperçu : mêmes règles qu'un nettoyage, images comprises.
    const problem = latexProblem(body.latex, mode, result.latex)
    if (problem !== null) throw new InvalidConvertedLatexException(`Invalid LaTeX: ${problem}`)
    latex = body.latex
  }
  const problem = latexProblem(latex, mode)
  if (problem !== null) throw new InvalidConvertedLatexException(`Invalid LaTeX: ${problem}`)

  const preamble = preambleResult(preambleMode, main ?? null, latex, result.preamble)
  const warnings = [...result.warnings]
  const bibliography = citationWarning(
    result.citations,
    content.documents
      .filter((document) => /\.bib$/i.test(document.path))
      .map((document) => document.content),
  )
  if (bibliography !== null) warnings.push(bibliography)
  if (cleanupResult?.warning) warnings.push(cleanupResult.warning)

  const pending: PendingMedia[] = result.media.map((item) => {
    const decoded = Buffer.from(item.contentBase64, 'base64')
    return {
      path: item.path,
      contentType: item.contentType,
      content: decoded,
      sha256: sha256(decoded),
      existingSha: occupied.entries.get(item.path) ?? null,
    }
  })
  for (const item of pending) {
    // Nommées d'après leur contenu : un même chemin avec un autre contenu est un vrai conflit.
    const taken =
      occupied.folders.has(item.path) ||
      blockedByEntry(item.path, occupied.entries) ||
      (occupied.entries.has(item.path) && item.existingSha !== item.sha256)
    if (taken) throw new NameTakenException(`${item.path} already exists`)
  }

  const base = {
    output,
    targetPath,
    latex,
    pandocLatex,
    sourceSha256,
    citations: result.citations,
    title: result.title,
    images: result.images,
    warnings,
    preamble,
    cleanup: cleanupResult,
  }
  if (dryRun) {
    return {
      ...base,
      dryRun: true,
      document: null,
      media: pending.map((item) => ({
        id: null,
        path: item.path,
        contentType: item.contentType,
        sizeBytes: item.content.byteLength,
        created: item.existingSha === null,
      })),
      durationMs: Math.round(performance.now() - started),
    }
  }

  const written = await writeImport(deps, user, projectId, {
    output,
    targetPath,
    latex,
    media: pending,
  })
  return {
    ...base,
    dryRun: false,
    document: written.document,
    media: written.media,
    durationMs: Math.round(performance.now() - started),
  }
}

/** Préambule à prévoir : ce que le fragment utilise, et ce que le document principal n'a pas. */
function preambleResult(
  mode: 'main' | 'embedded',
  main: { id: string; path: string; content: string } | null,
  latex: string,
  pandocPreamble: string | null,
): MarkdownImportPreambleResult {
  if (mode === 'embedded') {
    return {
      mode,
      mainDocumentId: main?.id ?? null,
      mainDocumentPath: main?.path ?? null,
      packages: [],
      definitions: [],
      missingPackages: [],
      missingDefinitions: [],
    }
  }
  const required = pandocRequirements(latex, pandocPreamble)
  const missing = missingRequirements(main?.content ?? null, required)
  return {
    mode,
    mainDocumentId: main?.id ?? null,
    mainDocumentPath: main?.path ?? null,
    packages: required.packages,
    definitions: required.definitions,
    missingPackages: missing.packages,
    missingDefinitions: missing.definitions,
  }
}

/**
 * Écritures : objets S3 des nouvelles images d'abord (supprimés si la transaction échoue), puis
 * dossiers, fichiers et document dans une transaction qui verrouille le projet (droits relus,
 * stockage du propriétaire vérifié, noms revérifiés). Chaque image est relue au chemin visé dans
 * la transaction : réutilisée si un import concurrent l'a déjà créée avec le même contenu,
 * téléversée et recréée si elle a disparu depuis l'instantané. L'événement suit la validation.
 */
async function writeImport(
  deps: MarkdownImportDependencies,
  user: User,
  projectId: string,
  input: { output: 'file' | 'insert'; targetPath: string; latex: string; media: PendingMedia[] },
): Promise<{ document: MarkdownImportResponse['document']; media: ImportedMedia[] }> {
  const stored: string[] = []
  let committed = false
  const uploads = new Map<PendingMedia, { fileId: string; key: string }>()
  const upload = async (item: PendingMedia) => {
    const fileId = randomUUID()
    const key = fileKey(projectId, fileId)
    await deps.storage.putBuffer(key, item.content, item.contentType)
    stored.push(key)
    uploads.set(item, { fileId, key })
  }
  try {
    for (const item of input.media) {
      if (item.existingSha === null) await upload(item)
    }
    const outcome = await db.transaction(async (trx) => {
      const { project } = await projectFor(user, projectId, 'edit', { trx, lock: true })
      const folders: Folder[] = []
      const placed: { item: PendingMedia; folderId: string | null; existing: File | null }[] = []
      for (const item of input.media) {
        const folderId = await ensureFolders(trx, projectId, dirname(item.path), folders)
        const query = File.query({ client: trx }).where({ projectId, name: basename(item.path) })
        if (folderId === null) void query.whereNull('folderId')
        else void query.where('folderId', folderId)
        const existing: File | null = await query.first()
        // Nommées d'après leur contenu : un autre contenu au même chemin est un vrai conflit.
        if (existing !== null && existing.sha256 !== item.sha256) {
          throw new NameTakenException(`${item.path} already exists`)
        }
        // Présente dans l'instantané mais supprimée depuis : téléversée maintenant.
        if (existing === null && !uploads.has(item)) await upload(item)
        placed.push({ item, folderId, existing })
      }
      const newBytes =
        (input.output === 'file' ? bytes(input.latex) : 0) +
        placed.reduce(
          (total, entry) => total + (entry.existing === null ? entry.item.content.byteLength : 0),
          0,
        )
      await assertProjectStorageAvailable(project, newBytes, { requester: user, trx })
      const changes: TreeChange[] = []
      const media: ImportedMedia[] = []
      const usedKeys: string[] = []
      for (const { item, folderId, existing } of placed) {
        const target = uploads.get(item)
        if (existing !== null || target === undefined) {
          media.push({
            id: existing?.id ?? null,
            path: item.path,
            contentType: item.contentType,
            sizeBytes: item.content.byteLength,
            created: false,
          })
          continue
        }
        const file = await createFile(trx, projectId, {
          id: target.fileId,
          name: basename(item.path),
          folderId,
          s3Key: target.key,
          sha256: item.sha256,
          sizeBytes: item.content.byteLength,
          mimeType: item.contentType,
        })
        usedKeys.push(target.key)
        changes.push({
          action: 'created',
          entity: 'file',
          id: file.id,
          parentId: folderId,
          name: file.name,
        })
        media.push({
          id: file.id,
          path: item.path,
          contentType: item.contentType,
          sizeBytes: item.content.byteLength,
          created: true,
        })
      }
      let document: MarkdownImportResponse['document'] = null
      if (input.output === 'file') {
        const folderId = await ensureFolders(trx, projectId, dirname(input.targetPath), folders)
        // Historique : contenu initial attribué à la personne qui importe.
        const created = await createDocument(trx, projectId, {
          name: basename(input.targetPath),
          folderId,
          content: input.latex,
          authorId: user.id,
        })
        document = {
          id: created.id,
          folderId: created.folderId,
          name: created.name,
          path: input.targetPath,
        }
        changes.push({
          action: 'created',
          entity: 'document',
          id: created.id,
          parentId: folderId,
          name: created.name,
        })
      }
      if (folders.length > 0 || changes.length > 0) await touchProject(trx, projectId)
      const folderChanges: TreeChange[] = folders.map((folder) => ({
        action: 'created',
        entity: 'folder',
        id: folder.id,
        parentId: folder.parentId,
        name: folder.name,
      }))
      return { document, media, usedKeys, changes: [...folderChanges, ...changes] }
    })
    committed = true
    // Objets téléversés pour des images qu'un import concurrent a créées entre-temps : inutiles.
    const unused = stored.filter((key) => !outcome.usedKeys.includes(key))
    if (unused.length > 0) {
      await deps.storage.delete(unused).catch((cleanupError: unknown) => {
        logger.warn({ err: cleanupError, projectId }, 'unused converted media not deleted')
      })
    }
    if (outcome.changes.length > 0) {
      await deps.realtime.publishProjectEvent(projectId, {
        type: 'tree.changed',
        reason: 'create',
        actorId: user.id,
        // Trop de changements : le client relit toute l'arborescence.
        changes: outcome.changes.length > MAX_TREE_CHANGES ? [] : outcome.changes,
      })
    }
    return { document: outcome.document, media: outcome.media }
  } catch (error) {
    // Après la validation, les objets sont référencés : jamais supprimés.
    if (!committed && stored.length > 0) {
      await deps.storage.delete(stored).catch((cleanupError: unknown) => {
        logger.warn({ err: cleanupError, projectId }, 'converted media not deleted')
      })
    }
    throw error
  }
}
