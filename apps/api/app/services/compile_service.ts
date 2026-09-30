import { randomUUID } from 'node:crypto'
import {
  compileOutputPrefix,
  type CompileRequest,
  compileRequestSchema,
  type CompileResult,
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

const ENTRIES_FILE = 'entries.json'
const entriesSchema = logEntrySchema.array()

/** Entrée affichée dans le panneau de logs quand aucun agent n'a pu compiler. */
function unavailableEntry(): LogEntry {
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

async function outputUrls(outputs: CompileOutputStorage, prefix: string, names: Set<string>) {
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
  return { pdfUrl, logUrl }
}

/**
 * Compile un projet : demande construite par l'API, envoyée au gateway ; résultat enregistré dans
 * compiles, entrées du log gardées à côté des sorties (pour « dernière compilation »).
 */
export async function compileProject(
  deps: CompileDependencies,
  user: User,
  project: Project,
): Promise<CompileResult> {
  const request = await buildCompileRequest(deps.realtime, project, deps.outputs.bucket)
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
  const compile = await Compile.query()
    .where('projectId', projectId)
    .orderBy('createdAt', 'desc')
    .first()
  if (!compile) return null
  const prefix = compile.outputPrefix
  const [pdfSize, logSize] = await Promise.all([
    outputs.size(`${prefix}output.pdf`),
    outputs.size(`${prefix}output.log`),
  ])
  let entries: LogEntry[] = []
  if ((await outputs.size(`${prefix}${ENTRIES_FILE}`)) !== null) {
    const raw = Buffer.concat(await (await outputs.read(`${prefix}${ENTRIES_FILE}`)).toArray())
    entries = entriesSchema.catch([]).parse(JSON.parse(raw.toString('utf8')))
  }
  const names = new Set([
    ...(pdfSize === null ? [] : ['output.pdf']),
    ...(logSize === null ? [] : ['output.log']),
  ])
  return {
    buildId: compile.id,
    status: compile.status,
    durationMs: compile.durationMs,
    entries,
    ...(await outputUrls(outputs, prefix, names)),
  }
}
