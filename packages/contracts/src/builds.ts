import { z } from 'zod'
import { compilerSchema } from './common.js'
import { compileResultSchema, outputFileSchema } from './compile.js'
import { logEntrySchema } from './log.js'
import { synctexCodeQuerySchema, synctexPdfQuerySchema } from './synctex.js'

/**
 * Compilation asynchrone (Cloudflare Worker + Containers) : l'API répond 202 avec un `buildId`,
 * le Worker rappelle l'API à chaque changement d'état, et le résultat est poussé aux clients par
 * le service temps réel. `GET /projects/:id/builds/:buildId` sert de repli par sondage.
 */

/**
 * États d'une compilation. `queued` : acceptée par l'API ; `preparing` : conteneur en cours de
 * réveil ; `running` : latexmk tourne. Les autres sont finaux.
 */
export const buildStatusSchema = z.enum([
  'queued',
  'preparing',
  'running',
  'success',
  'failure',
  'timeout',
  'error',
  'cancelled',
])
export type BuildStatus = z.infer<typeof buildStatusSchema>

export const ACTIVE_BUILD_STATUSES = ['queued', 'preparing', 'running'] as const
export const FINAL_BUILD_STATUSES = [
  'success',
  'failure',
  'timeout',
  'error',
  'cancelled',
] as const satisfies readonly BuildStatus[]

export function isFinalBuildStatus(status: BuildStatus): boolean {
  return (FINAL_BUILD_STATUSES as readonly BuildStatus[]).includes(status)
}

/**
 * Réponse 202 de `POST /projects/:id/compile` en mode asynchrone : `preparing` quand le conteneur
 * du projet se réveille (l'interface affiche « Préparation du compilateur… »). Ce n'est que l'état
 * initial : la réponse peut arriver après des événements `compile` du même `buildId` (rappels du
 * Worker) ; le client qui en a déjà reçu un ignore ce statut.
 */
export const compileAcceptedSchema = z.object({
  buildId: z.uuid(),
  status: z.enum(['queued', 'preparing']),
})
export type CompileAccepted = z.infer<typeof compileAcceptedSchema>

/** `GET /projects/:id/builds/:buildId` : état courant ; `result` seulement une fois terminée. */
export const buildStateSchema = z.object({
  buildId: z.uuid(),
  projectId: z.uuid(),
  status: buildStatusSchema,
  compiler: compilerSchema,
  createdAt: z.iso.datetime({ offset: true }),
  finishedAt: z.iso.datetime({ offset: true }).nullable(),
  result: compileResultSchema.nullable(),
})
export type BuildState = z.infer<typeof buildStateSchema>

/** Événement diffusé par le service temps réel aux connexions du projet. */
export const compileEventSchema = z.object({
  type: z.literal('compile'),
  projectId: z.uuid(),
  buildId: z.uuid(),
  status: buildStatusSchema,
  /** Présent quand la compilation est terminée (URL présignées valables 1 heure). */
  result: compileResultSchema.nullable(),
  /**
   * Vrai quand le résultat, trop gros pour un événement (log très bavard), a été retiré : le client
   * le lit par `GET /projects/:id/builds/:buildId`.
   */
  resultOmitted: z.boolean().optional(),
})
export type CompileEvent = z.infer<typeof compileEventSchema>

/**
 * Message sans état envoyé par `POST /internal/projects/:id/events` du service temps réel. Union
 * discriminée par `type`, que d'autres événements de projet pourront rejoindre.
 */
export const projectEventSchema = z.discriminatedUnion('type', [compileEventSchema])
export type ProjectEvent = z.infer<typeof projectEventSchema>

/** Taille maximale du corps de `POST /internal/projects/:id/events` (service temps réel). */
export const MAX_PROJECT_EVENT_BYTES = 1024 * 1024

/**
 * Événement prêt à envoyer au service temps réel : un résultat de compilation qui dépasserait
 * `MAX_PROJECT_EVENT_BYTES` est retiré (`resultOmitted`), le client le relit par l'API.
 */
export function fitProjectEvent(event: ProjectEvent): ProjectEvent {
  if (event.result === null) return event
  if (new TextEncoder().encode(JSON.stringify(event)).byteLength <= MAX_PROJECT_EVENT_BYTES) {
    return event
  }
  return { ...event, result: null, resultOmitted: true }
}

export const projectEventResponseSchema = z.object({ delivered: z.number().int().nonnegative() })
export type ProjectEventResponse = z.infer<typeof projectEventResponseSchema>

/** `POST /projects/:id/compiler/warm` de l'API (réveil anticipé à l'ouverture de l'éditeur). */
export const warmCompilerResponseSchema = z.object({
  status: z.enum(['warming', 'unsupported']),
})
export type WarmCompilerResponse = z.infer<typeof warmCompilerResponseSchema>

// --- API → Worker -------------------------------------------------------------------------------

/**
 * Clé R2 (bucket des sorties) de la demande de compilation complète écrite par l'API : le Worker
 * la relit, puis lit les fichiers binaires du projet dans le bucket des fichiers.
 */
export function compileRequestKey(projectId: string, buildId: string): string {
  return `outputs/${projectId}/${buildId}/request.json`
}

/** `POST /projects/:projectId/compile` du Worker. */
export const workerCompileJobSchema = z.object({
  projectId: z.uuid(),
  buildId: z.uuid(),
  requestKey: z.string().min(1).max(1024),
})
export type WorkerCompileJob = z.infer<typeof workerCompileJobSchema>

export const workerEnqueueResponseSchema = z.object({
  buildId: z.uuid(),
  status: z.enum(['queued', 'preparing']),
})
export type WorkerEnqueueResponse = z.infer<typeof workerEnqueueResponseSchema>

/** `POST /projects/:projectId/cancel` du Worker. */
export const workerCancelSchema = z.object({ buildId: z.uuid() })
export type WorkerCancel = z.infer<typeof workerCancelSchema>

/**
 * SyncTeX par le Worker : `buildId` désigne la compilation dont le fichier SyncTeX est dans R2,
 * restauré dans le conteneur s'il a été recyclé depuis.
 */
export const workerSynctexCodeQuerySchema = synctexCodeQuerySchema.extend({ buildId: z.uuid() })
export type WorkerSynctexCodeQuery = z.infer<typeof workerSynctexCodeQuerySchema>
export const workerSynctexPdfQuerySchema = synctexPdfQuerySchema.extend({ buildId: z.uuid() })
export type WorkerSynctexPdfQuery = z.infer<typeof workerSynctexPdfQuerySchema>

// --- Worker → API -------------------------------------------------------------------------------

/**
 * Rappel du Worker (`POST /api/v1/internal/compile-callbacks`, corps signé). `seq` croît à chaque
 * rappel d'une compilation : l'API ignore un rappel rejoué ou arrivé dans le désordre.
 */
export const workerCallbackSchema = z
  .object({
    projectId: z.uuid(),
    buildId: z.uuid(),
    seq: z.number().int().positive(),
    status: buildStatusSchema.exclude(['queued']),
    durationMs: z.number().int().nonnegative().optional(),
    entries: z.array(logEntrySchema).optional(),
    outputFiles: z.array(outputFileSchema).optional(),
    /** Identifiant de l'instance de conteneur (statistiques « par agent »). */
    agentId: z.string().min(1).max(255).optional(),
  })
  .superRefine((callback, ctx) => {
    const final = isFinalBuildStatus(callback.status)
    if (final && (callback.durationMs === undefined || callback.entries === undefined)) {
      ctx.addIssue({
        code: 'custom',
        message: 'A final callback carries durationMs and entries',
        path: ['status'],
      })
    }
    for (const [index, file] of (callback.outputFiles ?? []).entries()) {
      if (!file.s3Key.startsWith(`outputs/${callback.projectId}/${callback.buildId}/`)) {
        ctx.addIssue({
          code: 'custom',
          message: 'Output files belong to the build prefix',
          path: ['outputFiles', index, 's3Key'],
        })
      }
    }
  })
export type WorkerCallback = z.infer<typeof workerCallbackSchema>

export const workerCallbackResponseSchema = z.object({ applied: z.boolean() })
export type WorkerCallbackResponse = z.infer<typeof workerCallbackResponseSchema>
