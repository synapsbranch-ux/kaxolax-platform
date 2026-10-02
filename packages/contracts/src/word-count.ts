import { z } from 'zod'
import { textResourceSchema } from './compile.js'
import { relativePathSchema } from './names.js'

/** Délai de texcount dans le sandbox (un document de plusieurs centaines de pages : < 2 s). */
export const WORD_COUNT_TIMEOUT_MS = 20_000
/** Nombre maximal de documents envoyés à texcount. */
export const MAX_WORD_COUNT_RESOURCES = 2_000
/** Taille cumulée maximale du texte envoyé à texcount (octets UTF-8). */
export const MAX_WORD_COUNT_TEXT_BYTES = 16 * 1024 * 1024

/** Documents comptés : le principal et ceux qu'il peut inclure (\input, \include, \subfile). */
export const WORD_COUNT_EXTENSIONS = /\.(?:tex|ltx)$/i

const encoder = new TextEncoder()

/**
 * Demande de comptage : API → gateway (ou Worker) → agent. Seuls des documents texte voyagent :
 * texcount n'a besoin ni des images ni des binaires du projet.
 */
export const wordCountRequestSchema = z
  .object({
    projectId: z.uuid(),
    rootResourcePath: relativePathSchema,
    resources: z.array(textResourceSchema).min(1).max(MAX_WORD_COUNT_RESOURCES),
  })
  .superRefine((request, ctx) => {
    const paths = new Set<string>()
    let bytes = 0
    for (const [index, resource] of request.resources.entries()) {
      if (paths.has(resource.path)) {
        ctx.addIssue({
          code: 'custom',
          message: `Duplicate path: ${resource.path}`,
          path: ['resources', index, 'path'],
        })
      }
      paths.add(resource.path)
      bytes += encoder.encode(resource.content).byteLength
    }
    if (bytes > MAX_WORD_COUNT_TEXT_BYTES) {
      ctx.addIssue({ code: 'custom', message: 'Documents are too large', path: ['resources'] })
    }
    if (!paths.has(request.rootResourcePath)) {
      ctx.addIssue({
        code: 'custom',
        message: 'Root resource must be one of the resources',
        path: ['rootResourcePath'],
      })
    }
  })
export type WordCountRequest = z.infer<typeof wordCountRequestSchema>

const count = z.number().int().nonnegative()

/**
 * Compteurs de texcount : `text` (mots du texte), `headers` (mots des titres), `captions` (mots
 * hors texte : légendes, notes de figures…), et `words`, leur somme. Puis le nombre de titres, de
 * flottants, de formules en ligne et de formules centrées.
 */
export const wordCountsSchema = z.object({
  words: count,
  text: count,
  headers: count,
  captions: count,
  headerCount: count,
  floatCount: count,
  inlineMathCount: count,
  displayMathCount: count,
})
export type WordCounts = z.infer<typeof wordCountsSchema>

/** Niveau d'une section de texcount ; `top` : tout ce qui précède le premier titre. */
export const wordCountSectionKindSchema = z.enum([
  'top',
  'part',
  'chapter',
  'section',
  'subsection',
  'subsubsection',
  'paragraph',
  'other',
])
export type WordCountSectionKind = z.infer<typeof wordCountSectionKindSchema>

export const wordCountSectionSchema = wordCountsSchema.extend({
  kind: wordCountSectionKindSchema,
  title: z.string(),
})
export type WordCountSection = z.infer<typeof wordCountSectionSchema>

/**
 * Résultat de texcount analysé (agent → gateway → API → navigateur). `sections` : détail par
 * partie, chapitre et section, documents inclus fusionnés à leur place. `warnings` : problèmes
 * signalés par texcount (fichier inclus introuvable, accolade non fermée…).
 */
export const wordCountResultSchema = z.object({
  total: wordCountsSchema,
  sections: z.array(wordCountSectionSchema),
  warnings: z.array(z.string()),
})
export type WordCountResult = z.infer<typeof wordCountResultSchema>

/** Corps (facultatif) de `POST /projects/:id/word-count` : un autre document que le principal. */
export const wordCountBodySchema = z.strictObject({
  documentId: z.uuid().optional(),
})
export type WordCountBody = z.infer<typeof wordCountBodySchema>

/** Réponse de l'API : le résultat et le document compté (chemin dans le projet). */
export const wordCountResponseSchema = wordCountResultSchema.extend({
  rootResourcePath: relativePathSchema,
  durationMs: count,
})
export type WordCountResponse = z.infer<typeof wordCountResponseSchema>
