import {
  ACTIVE_BUILD_STATUSES,
  type BuildState,
  type BuildStatus,
  type CompileAccepted,
  type CompileOptions,
  compileRequestKey,
  type CompileResult,
  compileStatusSchema,
  isFinalBuildStatus,
  type LogEntry,
  type WorkerCallback,
} from '@kaxolax/contracts'
import { Exception } from '@adonisjs/core/exceptions'
import type { HttpContext } from '@adonisjs/core/http'
import logger from '@adonisjs/core/services/logger'
import db from '@adonisjs/lucid/services/db'
import { DateTime } from 'luxon'
import compileConfig from '#config/compile'
import Compile from '#models/compile'
import Project from '#models/project'
import type User from '#models/user'
import { NoCompileOutputException } from '#services/compile_gateway'
import {
  buildCompileRequest,
  compileResultOf,
  ENTRIES_FILE,
  outputUrls,
  unavailableEntry,
} from '#services/compile_service'
import type CompileWorkerClient from '#services/compile_worker'
import { reserveCompiler } from '#services/compiler_quota'
import type { CompileOutputStorage } from '#services/object_storage'
import { compileTimeoutMs, withCompileTimeLimit } from '#services/plan_enforcement'
import type RealtimeClient from '#services/realtime_client'

/** Une compilation est déjà en cours sur le projet : le client peut la suivre ou l'arrêter. */
export class CompileInProgressException extends Exception {
  static override status = 409
  static override code = 'E_COMPILE_IN_PROGRESS'
  static override message = 'A compilation is already running for this project'

  constructor(readonly buildId: string | null) {
    super()
  }

  handle(error: this, { response }: HttpContext) {
    response
      .status(error.status)
      .send({ code: error.code, message: error.message, buildId: error.buildId })
  }
}

export class BuildNotFoundException extends Exception {
  static override status = 404
  static override code = 'E_BUILD_NOT_FOUND'
  static override message = 'Build not found'
}

export interface AsyncCompileDependencies {
  worker: CompileWorkerClient
  realtime: RealtimeClient
  outputs: CompileOutputStorage
}

const ACTIVE = [...ACTIVE_BUILD_STATUSES]
/** Littéral SQL des états actifs : il doit reprendre le prédicat de l'index unique partiel. */
const ACTIVE_SQL = `(${ACTIVE.map((status) => `'${status}'`).join(', ')})`
/** Durée écoulée depuis la demande, en ms, bornée à la plage d'un integer. */
const ELAPSED_MS = `LEAST(2147483647, GREATEST(0, EXTRACT(EPOCH FROM now() - created_at) * 1000))::int`

/** Exécute une mise à jour `… RETURNING id` et renvoie les compilations touchées. */
async function updateBuilds(sql: string, bindings: unknown[]): Promise<string[]> {
  const result = await db.rawQuery<{ rows: { id: string }[] }>(sql, bindings)
  return result.rows.map((row) => row.id)
}

/**
 * Événement `compile.updated` sur le document meta du projet (même route et même enveloppe que les
 * autres événements du projet). Au mieux : le client garde le repli par sondage.
 */
async function publishStatus(
  realtime: RealtimeClient,
  projectId: string,
  buildId: string,
  status: BuildStatus,
  result: CompileResult | null = null,
): Promise<void> {
  await realtime.publishProjectEvent(projectId, {
    type: 'compile.updated',
    buildId,
    status,
    result,
  })
}

/** Entrée du log d'une compilation close faute de nouvelles du Worker. */
export function noResponseEntry(): LogEntry {
  return {
    level: 'error',
    file: null,
    line: null,
    message: 'The compiler did not respond in time. Try again in a moment.',
    raw: '',
  }
}

/**
 * Clôt en erreur les compilations actives du projet restées sans nouvelles du Worker au-delà de
 * leur timeout plus une marge : le verrou « une compilation à la fois » ne reste jamais bloqué.
 * Une entrée de log explique l'erreur (le panneau des logs n'est pas vide).
 */
export async function expireStaleBuilds(
  deps: Pick<AsyncCompileDependencies, 'outputs' | 'realtime'>,
  projectId: string,
): Promise<void> {
  const result = await db.rawQuery<{
    rows: { id: string; output_prefix: string; duration_ms: number }[]
  }>(
    `UPDATE compiles SET status = 'error', finished_at = now(), updated_at = now(),
       duration_ms = ${ELAPSED_MS}
     WHERE project_id = ? AND status = ANY(CAST(? AS text[]))
       AND created_at < now() - interval '1 millisecond' * (COALESCE(timeout_ms, CAST(? AS integer)) + CAST(? AS integer))
     RETURNING id, output_prefix, duration_ms`,
    [projectId, ACTIVE, compileConfig.timeoutMs, compileConfig.staleBuildMarginMs],
  )
  for (const row of result.rows) {
    logger.warn({ projectId, buildId: row.id }, 'compile worker never reported back, build closed')
    const entries = [noResponseEntry()]
    await deps.outputs
      .putBuffer(
        `${row.output_prefix}${ENTRIES_FILE}`,
        Buffer.from(JSON.stringify(entries)),
        'application/json',
      )
      .catch((error: unknown) => {
        logger.warn({ err: error, buildId: row.id }, 'could not write the log entries')
      })
    await publishStatus(deps.realtime, projectId, row.id, 'error', {
      buildId: row.id,
      status: 'error',
      durationMs: row.duration_ms,
      entries,
      pdfUrl: null,
      logUrl: null,
    })
  }
}

/**
 * Compilation asynchrone : la ligne `queued` est le verrou du projet (index unique partiel), la
 * demande complète est écrite dans R2 à côté des sorties, puis le Worker la met en file.
 */
export async function enqueueCompile(
  deps: AsyncCompileDependencies,
  user: User,
  project: Project,
  options: CompileOptions = {},
): Promise<CompileAccepted> {
  await reserveCompiler(user.id, project.id)
  // Durée maximale du plan du propriétaire (claims du jeton s'il compile lui-même).
  const timeoutMs = await compileTimeoutMs(project.ownerId, user)
  const request = await buildCompileRequest(
    deps.realtime,
    project,
    deps.outputs.bucket,
    options,
    timeoutMs,
  )
  await expireStaleBuilds(deps, project.id)
  // INSERT … ON CONFLICT sur l'index unique partiel : deux demandes simultanées, une seule passe.
  const inserted = await db.rawQuery<{ rows: unknown[] }>(
    `INSERT INTO compiles (id, project_id, user_id, compiler, status, duration_ms, output_prefix,
       backend, timeout_ms, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'queued', 0, ?, 'cloudflare', ?, now(), now())
     ON CONFLICT (project_id) WHERE status IN ${ACTIVE_SQL} DO NOTHING
     RETURNING id`,
    [
      request.buildId,
      project.id,
      user.id,
      request.compiler,
      request.output.prefix,
      request.timeoutMs,
    ],
  )
  if (inserted.rows.length === 0) {
    const active = await Compile.query()
      .where('projectId', project.id)
      .whereIn('status', ACTIVE)
      .first()
    throw new CompileInProgressException(active?.id ?? null)
  }
  // Publié avant l'appel au Worker : ses rappels (`preparing`, `running`) peuvent arriver avant sa
  // réponse, et le client ne doit pas revenir en arrière.
  await publishStatus(deps.realtime, project.id, request.buildId, 'queued')

  let accepted: CompileAccepted['status']
  try {
    const key = compileRequestKey(project.id, request.buildId)
    await deps.outputs.putBuffer(key, Buffer.from(JSON.stringify(request)), 'application/json')
    accepted = (
      await deps.worker.enqueue({
        projectId: project.id,
        buildId: request.buildId,
        requestKey: key,
      })
    ).status
  } catch (error) {
    // Le Worker n'a pas pris la demande : la compilation se termine en erreur, le verrou est libéré.
    logger.warn({ err: error, projectId: project.id }, 'compile worker unavailable')
    await deps.outputs
      .putBuffer(
        `${request.output.prefix}${ENTRIES_FILE}`,
        Buffer.from(JSON.stringify([unavailableEntry()])),
        'application/json',
      )
      .catch(() => undefined)
    await Compile.query().where('id', request.buildId).whereIn('status', ACTIVE).update({
      status: 'error',
      finishedAt: DateTime.utc().toSQL(),
      updatedAt: DateTime.utc().toSQL(),
    })
    await publishStatus(deps.realtime, project.id, request.buildId, 'error')
    throw error
  }
  if (accepted === 'preparing') {
    // Le conteneur se réveille (« Préparation du compilateur… ») ; seulement si aucun rappel du
    // Worker n'a déjà fait avancer la compilation.
    const prepared = await updateBuilds(
      `UPDATE compiles SET status = 'preparing', updated_at = now()
       WHERE id = ? AND status = 'queued' AND last_event_seq = 0 RETURNING id`,
      [request.buildId],
    )
    if (prepared.length > 0) {
      await publishStatus(deps.realtime, project.id, request.buildId, 'preparing')
    }
  }
  // Statut renvoyé par le Worker, jamais ramené en arrière. La réponse peut arriver après des
  // événements du même build : le client garde l'état de l'événement le plus récent
  // (contrat `compileAcceptedSchema`).
  return { buildId: request.buildId, status: accepted }
}

/**
 * Rappel du Worker (signature déjà vérifiée). Idempotent : un rappel sur une compilation terminée,
 * ou dont le numéro de séquence n'est pas plus grand que le dernier appliqué, est ignoré.
 */
export async function applyWorkerCallback(
  deps: Pick<AsyncCompileDependencies, 'outputs' | 'realtime'>,
  callback: WorkerCallback,
): Promise<{ applied: boolean; found: boolean }> {
  const known = await Compile.query()
    .where('id', callback.buildId)
    .where('projectId', callback.projectId)
    .first()
  if (!known) return { applied: false, found: false }
  if (isFinalBuildStatus(known.status) || callback.seq <= known.lastEventSeq) {
    return { applied: false, found: true }
  }
  const status = compileStatusSchema.safeParse(callback.status)
  const entries = callback.entries ?? []
  if (status.success) {
    // Écrit avant le statut final : un sondage ne voit jamais un résultat final sans ses entrées.
    // Un échec remonte en 5xx et le Worker réessaie.
    await deps.outputs.putBuffer(
      `${known.outputPrefix}${ENTRIES_FILE}`,
      Buffer.from(JSON.stringify(entries)),
      'application/json',
    )
  }

  let previous: BuildStatus = known.status
  const compile = await db.transaction(async (trx) => {
    const row = await Compile.query({ client: trx })
      .where('id', callback.buildId)
      .where('projectId', callback.projectId)
      .forUpdate()
      .first()
    if (!row || isFinalBuildStatus(row.status) || callback.seq <= row.lastEventSeq) return null
    previous = row.status
    row.useTransaction(trx)
    row.merge({ status: callback.status, lastEventSeq: callback.seq })
    if (callback.agentId !== undefined) row.agentId = callback.agentId
    if (isFinalBuildStatus(callback.status)) {
      row.durationMs = callback.durationMs ?? 0
      row.finishedAt = DateTime.utc()
    }
    await row.save()
    return row
  })
  if (compile === null) return { applied: false, found: true }

  let result: CompileResult | null = null
  if (status.success) {
    // Sans toucher updated_at : le tableau de bord trie par dernière modification du contenu.
    await Project.query()
      .where('id', compile.projectId)
      .update({ lastCompiledAt: DateTime.utc().toSQL() })
    const names = new Set(callback.outputFiles?.map((file) => file.name) ?? [])
    result = await withCompileTimeLimit(
      {
        buildId: compile.id,
        status: status.data,
        durationMs: compile.durationMs,
        entries,
        ...(await outputUrls(deps.outputs, compile.outputPrefix, names)),
      },
      { projectId: compile.projectId, timeoutMs: compile.timeoutMs },
    )
  }
  // `preparing` déjà annoncé par la réponse du Worker : pas de second événement identique.
  if (previous !== callback.status) {
    await publishStatus(deps.realtime, compile.projectId, compile.id, callback.status, result)
  }
  return { applied: true, found: true }
}

/** Arrête la compilation en cours du projet (annulée tout de suite, le Worker est prévenu). */
export async function cancelActiveBuild(
  deps: Pick<AsyncCompileDependencies, 'worker' | 'realtime'>,
  projectId: string,
): Promise<boolean> {
  const cancelled = await updateBuilds(
    `UPDATE compiles SET status = 'cancelled', finished_at = now(), updated_at = now(),
       duration_ms = ${ELAPSED_MS}
     WHERE project_id = ? AND status = ANY(CAST(? AS text[])) RETURNING id`,
    [projectId, ACTIVE],
  )
  for (const buildId of cancelled) {
    try {
      await deps.worker.cancel(projectId, buildId)
    } catch (error) {
      // Son rappel final sera ignoré : la compilation est déjà close.
      logger.warn({ err: error, projectId, buildId }, 'could not cancel the build on the worker')
    }
    await publishStatus(deps.realtime, projectId, buildId, 'cancelled')
  }
  return cancelled.length > 0
}

/**
 * État d'une compilation du projet ; le résultat seulement si elle est terminée. Repli par sondage :
 * une compilation dont le Worker ne donne plus de nouvelles est close ici (événement `error`).
 */
export async function buildState(
  deps: Pick<AsyncCompileDependencies, 'outputs' | 'realtime'>,
  projectId: string,
  buildId: string,
): Promise<BuildState> {
  const find = () => Compile.query().where('id', buildId).where('projectId', projectId).first()
  let compile = await find()
  if (!compile) throw new BuildNotFoundException()
  if (!isFinalBuildStatus(compile.status)) {
    await expireStaleBuilds(deps, projectId)
    compile = (await find()) ?? compile
  }
  const outputs = deps.outputs
  const done = compileStatusSchema.safeParse(compile.status).success
  return {
    buildId: compile.id,
    projectId: compile.projectId,
    status: compile.status,
    compiler: compile.compiler,
    createdAt: compile.createdAt.toISO() ?? '',
    finishedAt: compile.finishedAt?.toISO() ?? null,
    result: done ? await compileResultOf(outputs, compile) : null,
  }
}

/** Dernière compilation qui a produit des sorties (SyncTeX dans R2), sinon 404. */
export async function lastBuildWithOutputs(projectId: string): Promise<string> {
  const compile = await Compile.query()
    .where('projectId', projectId)
    .where('backend', 'cloudflare')
    .whereIn('status', ['success', 'failure'])
    .orderBy('createdAt', 'desc')
    .first()
  if (!compile) throw new NoCompileOutputException()
  return compile.id
}
