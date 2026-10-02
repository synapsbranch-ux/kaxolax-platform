import { z } from 'zod'
import { compileStatusSchema, compilerSchema, sha256Schema } from './common.js'
import { logEntrySchema } from './log.js'
import { relativePathSchema } from './names.js'

export const DEFAULT_COMPILE_TIMEOUT_MS = 60_000
export const MIN_COMPILE_TIMEOUT_MS = 1_000
export const MAX_COMPILE_TIMEOUT_MS = 600_000
export const MAX_COMPILE_RESOURCES = 10_000

/** Préfixe S3 des fichiers binaires d'un projet (bucket project-files). */
export function projectFilesPrefix(projectId: string): string {
  return `projects/${projectId}/`
}

/** Préfixe S3 des sorties d'une compilation (bucket compile-outputs). */
export function compileOutputPrefix(projectId: string, buildId: string): string {
  return `outputs/${projectId}/${buildId}/`
}

const s3KeySchema = z
  .string()
  .min(1)
  .max(1024)
  .refine((key) => !key.startsWith('/') && !key.split('/').includes('..'), {
    message: 'Invalid S3 key',
  })

export const textResourceSchema = z.object({
  path: relativePathSchema,
  kind: z.literal('text'),
  content: z.string(),
  sha256: sha256Schema,
})

export const binaryResourceSchema = z.object({
  path: relativePathSchema,
  kind: z.literal('binary'),
  s3Key: s3KeySchema,
  sha256: sha256Schema,
})

export const compileResourceSchema = z.discriminatedUnion('kind', [
  textResourceSchema,
  binaryResourceSchema,
])
export type CompileResource = z.infer<typeof compileResourceSchema>

/**
 * Options de compilation choisies par l'utilisateur. `draft` : graphicx et hyperref reçoivent
 * l'option draft (images remplacées par des cadres, pas de liens), sans modifier les fichiers du
 * projet. `haltOnFirstError` : le moteur s'arrête à la première erreur. Absentes = désactivées.
 */
export const compileOptionsSchema = z.strictObject({
  draft: z.boolean().optional(),
  haltOnFirstError: z.boolean().optional(),
})
export type CompileOptions = z.infer<typeof compileOptionsSchema>

/** Corps (facultatif) de `POST /projects/:id/compile`. */
export const compileProjectBodySchema = z.strictObject({
  options: compileOptionsSchema.optional(),
  /**
   * Origine de la demande : `manual` (défaut : bouton, raccourci) crée une version dans
   * l'historique, `auto` (auto-compilation après une frappe) n'en crée pas.
   */
  trigger: z.enum(['manual', 'auto']).optional(),
})
export type CompileProjectBody = z.infer<typeof compileProjectBodySchema>

/**
 * Demande de compilation : API vers le gateway (POST /compile), puis gateway vers l'agent
 * (POST /projects/:projectId/compile), avec le même corps.
 */
export const compileRequestSchema = z
  .object({
    projectId: z.uuid(),
    buildId: z.uuid(),
    compiler: compilerSchema,
    rootResourcePath: relativePathSchema,
    timeoutMs: z.number().int().min(MIN_COMPILE_TIMEOUT_MS).max(MAX_COMPILE_TIMEOUT_MS),
    options: compileOptionsSchema.optional(),
    resources: z.array(compileResourceSchema).min(1).max(MAX_COMPILE_RESOURCES),
    output: z.object({
      bucket: z.string().min(3).max(63),
      prefix: z.string(),
    }),
  })
  .superRefine((request, ctx) => {
    const files = new Set<string>()
    const folders = new Set<string>()
    for (const [index, resource] of request.resources.entries()) {
      if (files.has(resource.path) || folders.has(resource.path)) {
        ctx.addIssue({
          code: 'custom',
          message: `Duplicate or conflicting path: ${resource.path}`,
          path: ['resources', index, 'path'],
        })
      }
      files.add(resource.path)
      const segments = resource.path.split('/')
      for (let depth = 1; depth < segments.length; depth++) {
        const folder = segments.slice(0, depth).join('/')
        if (files.has(folder)) {
          ctx.addIssue({
            code: 'custom',
            message: `Path is used both as a file and a folder: ${folder}`,
            path: ['resources', index, 'path'],
          })
        }
        folders.add(folder)
      }
      if (
        resource.kind === 'binary' &&
        !resource.s3Key.startsWith(projectFilesPrefix(request.projectId))
      ) {
        ctx.addIssue({
          code: 'custom',
          message: 'Binary resource must belong to the project',
          path: ['resources', index, 's3Key'],
        })
      }
    }

    const root = request.resources.find((resource) => resource.path === request.rootResourcePath)
    if (root?.kind !== 'text') {
      ctx.addIssue({
        code: 'custom',
        message: 'Root resource must be one of the text resources',
        path: ['rootResourcePath'],
      })
    }

    if (request.output.prefix !== compileOutputPrefix(request.projectId, request.buildId)) {
      ctx.addIssue({
        code: 'custom',
        message: 'Output prefix must be outputs/{projectId}/{buildId}/',
        path: ['output', 'prefix'],
      })
    }
  })
export type CompileRequest = z.infer<typeof compileRequestSchema>

export const outputFileSchema = z.object({
  name: relativePathSchema,
  s3Key: s3KeySchema,
  sizeBytes: z.number().int().nonnegative(),
})
export type OutputFile = z.infer<typeof outputFileSchema>

/** Durées mesurées par l'agent, en millisecondes. */
export const compileTimingsSchema = z.object({
  syncMs: z.number().int().nonnegative(),
  runMs: z.number().int().nonnegative(),
  uploadMs: z.number().int().nonnegative(),
})
export type CompileTimings = z.infer<typeof compileTimingsSchema>

/** Réponse de l'agent (et corps relayé par le gateway, qui ajoute `agentId`). */
export const agentCompileResponseSchema = z.object({
  buildId: z.uuid(),
  status: compileStatusSchema,
  durationMs: z.number().int().nonnegative(),
  outputFiles: z.array(outputFileSchema),
  entries: z.array(logEntrySchema),
  timings: compileTimingsSchema,
})
export type AgentCompileResponse = z.infer<typeof agentCompileResponseSchema>

export const gatewayCompileResponseSchema = agentCompileResponseSchema.extend({
  agentId: z.string().min(1),
})
export type GatewayCompileResponse = z.infer<typeof gatewayCompileResponseSchema>

/** Fichiers de sortie téléchargeables (menu ⋯ du PDF), dans cet ordre quand ils existent. */
export const DOWNLOADABLE_OUTPUTS = [
  { name: 'output.log', label: 'Log de compilation', contentType: 'text/plain; charset=utf-8' },
  { name: 'output.synctex.gz', label: 'SyncTeX', contentType: 'application/gzip' },
  { name: 'output.bbl', label: 'Bibliographie (.bbl)', contentType: 'text/plain; charset=utf-8' },
  { name: 'output.blg', label: 'Log de BibTeX (.blg)', contentType: 'text/plain; charset=utf-8' },
] as const

/** Fichier de sortie téléchargeable : nom et lien présigné (téléchargement). */
export const outputDownloadSchema = z.object({
  name: z.string().min(1),
  url: z.url(),
})
export type OutputDownload = z.infer<typeof outputDownloadSchema>

/**
 * Réponse de l'API au navigateur. `logUrl` est nul seulement si la compilation a échoué avant
 * de produire un log (statut `error`, par exemple aucun agent disponible). `outputFiles` : sorties
 * téléchargeables disponibles (voir `DOWNLOADABLE_OUTPUTS`), absent dans les anciennes réponses.
 */
export const compileResultSchema = z.object({
  buildId: z.uuid(),
  status: compileStatusSchema,
  durationMs: z.number().int().nonnegative(),
  pdfUrl: z.url().nullable(),
  logUrl: z.url().nullable(),
  outputFiles: z.array(outputDownloadSchema).optional(),
  entries: z.array(logEntrySchema),
})
export type CompileResult = z.infer<typeof compileResultSchema>

export const stopCompileResponseSchema = z.object({ stopped: z.boolean() })
export type StopCompileResponse = z.infer<typeof stopCompileResponseSchema>

export const clearCacheResponseSchema = z.object({ cleared: z.boolean() })
export type ClearCacheResponse = z.infer<typeof clearCacheResponseSchema>

/** GET /health de l'agent : sert au gateway pour choisir l'agent le moins chargé. */
export const agentHealthSchema = z.object({
  agentId: z.string().min(1),
  activeCompiles: z.number().int().nonnegative(),
  capacity: z.number().int().positive(),
})
export type AgentHealth = z.infer<typeof agentHealthSchema>
