import { randomUUID } from 'node:crypto'
import {
  type CompileOptions,
  compileOutputPrefix,
  type CompileRequest,
  compileRequestSchema,
  type CompileResult,
  compileStatusSchema,
  DOWNLOADABLE_OUTPUTS,
  type GatewayCompileResponse,
  type LogEntry,
  logEntrySchema,
} from '@kaxolax/contracts'
import { Exception } from '@adonisjs/core/exceptions'
import logger from '@adonisjs/core/services/logger'
import { DateTime } from 'luxon'
import compileConfig from '#config/compile'
import Compile from '#models/compile'
import Project from '#models/project'
import type User from '#models/user'
import type CompileGateway from '#services/compile_gateway'
import { CompileServiceUnavailableException } from '#services/compile_gateway'
import type { CompileOutputStorage } from '#services/object_storage'
import { projectContent } from '#services/project_content'
import type RealtimeClient from '#services/realtime_client'

export class NoMainDocumentException extends Exception {
  static override status = 422
  static override code = 'E_NO_MAIN_DOCUMENT'
  static override message = 'Choose the main document of the project before compiling'
}

export interface CompileDependencies {
  gateway: CompileGateway
  realtime: RealtimeClient
  outputs: CompileOutputStorage
}

export const ENTRIES_FILE = 'entries.json'
const entriesSchema = logEntrySchema.array()

/** Entrée affichée dans le panneau de logs quand aucun agent n'a pu compiler. */
export function unavailableEntry(): LogEntry {
  return {
    level: 'error',
    file: null,
    line: null,
    message: 'The compile service is unavailable. Try again in a moment.',
    raw: '',
  }
}

/** Demande de compilation : instantané temps réel des documents et fichiers binaires, avec leurs chemins. */
export async function buildCompileRequest(
  realtime: RealtimeClient,
  project: Project,
  bucket: string,
  options: CompileOptions = {},
): Promise<CompileRequest> {
  const content = await projectContent(realtime, project.id)
  const main = content.documents.find((document) => document.id === project.mainDocumentId)
  if (!main) throw new NoMainDocumentException()
  const buildId = randomUUID()
  return compileRequestSchema.parse({
    projectId: project.id,
    buildId,
    compiler: project.compiler,
    rootResourcePath: main.path,
    timeoutMs: compileConfig.timeoutMs,
    options,
    resources: [
      ...content.documents.map((document) => ({
        path: document.path,
        kind: 'text' as const,
        content: document.content,
        sha256: document.sha256,
      })),
      ...content.files.map((file) => ({
        path: file.path,
        kind: 'binary' as const,
        s3Key: file.s3Key,
        sha256: file.sha256,
      })),
    ],
    output: { bucket, prefix: compileOutputPrefix(project.id, buildId) },
  })
}

/** URL présignées (1 heure) du PDF et du log d'une compilation, parmi les sorties `names`. */
export async function outputUrls(
  outputs: CompileOutputStorage,
  prefix: string,
  names: Set<string>,
) {
  const presign = (name: string, contentType: string) =>
    names.has(name)
      ? outputs.presignDownload(`${prefix}${name}`, name, {
          mode: 'inline',
          contentType,
          expiresIn: compileConfig.outputUrlTtlSeconds,
        })
      : Promise.resolve(null)
  const [pdfUrl, logUrl] = await Promise.all([
    presign('output.pdf', 'application/pdf'),
    presign('output.log', 'text/plain; charset=utf-8'),
  ])
  // Sorties proposées au téléchargement (menu ⋯ du PDF) : en pièce jointe.
  const available = DOWNLOADABLE_OUTPUTS.filter((output) => names.has(output.name))
  const outputFiles = await Promise.all(
    available.map(async (output) => ({
      name: output.name,
      url: await outputs.presignDownload(`${prefix}${output.name}`, output.name, {
        mode: 'attachment',
        contentType: output.contentType,
        expiresIn: compileConfig.outputUrlTtlSeconds,
      }),
    })),
  )
  return { pdfUrl, logUrl, outputFiles }
}

/**
 * Compile un projet (options : mode brouillon, arrêt à la première erreur) : demande construite
 * par l'API, envoyée au gateway ; résultat enregistré dans compiles, entrées du log gardées à côté
 * des sorties (pour « dernière compilation »).
 */
export async function compileProject(
  deps: CompileDependencies,
  user: User,
  project: Project,
  options: CompileOptions = {},
): Promise<CompileResult> {
  const request = await buildCompileRequest(deps.realtime, project, deps.outputs.bucket, options)
  const started = Date.now()
  let response: GatewayCompileResponse | null = null
  try {
    response = await deps.gateway.compile(request)
  } catch (error) {
    if (!(error instanceof CompileServiceUnavailableException)) throw error
    logger.warn({ err: error, projectId: project.id }, 'compile service unavailable')
  }

  const result = {
    buildId: request.buildId,
    status: response?.status ?? ('error' as const),
    durationMs: response?.durationMs ?? Date.now() - started,
    entries: response?.entries ?? [unavailableEntry()],
  }
  await Compile.create({
    id: request.buildId,
    projectId: project.id,
    userId: user.id,
    compiler: request.compiler,
    status: result.status,
    durationMs: result.durationMs,
    agentId: response?.agentId ?? null,
    outputPrefix: request.output.prefix,
    backend: 'gateway',
    timeoutMs: request.timeoutMs,
    finishedAt: DateTime.utc(),
  })
  // Sans toucher updated_at : le tableau de bord trie par dernière modification du contenu.
  await Project.query().where('id', project.id).update({ lastCompiledAt: DateTime.utc().toSQL() })
  await deps.outputs
    .putBuffer(
      `${request.output.prefix}${ENTRIES_FILE}`,
      Buffer.from(JSON.stringify(result.entries)),
      'application/json',
    )
    .catch((error: unknown) => {
      logger.warn({ err: error, buildId: request.buildId }, 'could not store log entries')
    })

  const names = new Set(response?.outputFiles.map((file) => file.name) ?? [])
  return { ...result, ...(await outputUrls(deps.outputs, request.output.prefix, names)) }
}

/**
 * Dernière compilation du projet, avec des URL fraîches. Les sorties expirent au bout de 7 jours :
 * les URL sont alors nulles.
 */
export async function lastCompile(
  outputs: CompileOutputStorage,
  projectId: string,
): Promise<CompileResult | null> {
  // Les compilations en cours ou annulées (mode asynchrone) n'ont pas de résultat à afficher.
  const compile = await Compile.query()
    .where('projectId', projectId)
    .whereIn('status', compileStatusSchema.options)
    .orderBy('createdAt', 'desc')
    .first()
  if (!compile) return null
  return compileResultOf(outputs, compile)
}

/** Résultat d'une compilation terminée (hors annulation) : entrées du log et URL fraîches. */
export async function compileResultOf(
  outputs: CompileOutputStorage,
  compile: Compile,
): Promise<CompileResult> {
  const prefix = compile.outputPrefix
  const outputNames = ['output.pdf', ...DOWNLOADABLE_OUTPUTS.map((output) => output.name)]
  const sizes = await Promise.all(outputNames.map((name) => outputs.size(`${prefix}${name}`)))
  let entries: LogEntry[] = []
  if ((await outputs.size(`${prefix}${ENTRIES_FILE}`)) !== null) {
    const raw = Buffer.concat(await (await outputs.read(`${prefix}${ENTRIES_FILE}`)).toArray())
    entries = entriesSchema.catch([]).parse(JSON.parse(raw.toString('utf8')))
  }
  const names = new Set(outputNames.filter((_, index) => sizes[index] !== null))
  return {
    buildId: compile.id,
    status: compileStatusSchema.parse(compile.status),
    durationMs: compile.durationMs,
    entries,
    ...(await outputUrls(outputs, prefix, names)),
  }
}
