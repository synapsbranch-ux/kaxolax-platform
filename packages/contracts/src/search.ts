import { z } from 'zod'

/** Longueur maximale du texte ou de l'expression régulière cherchés. */
export const MAX_SEARCH_QUERY_LENGTH = 200
/** Résultats renvoyés au plus par une recherche (au-delà : `truncated`). */
export const MAX_SEARCH_RESULTS = 500
/** Longueur maximale de l'extrait de ligne renvoyé avec chaque résultat. */
export const SEARCH_PREVIEW_LENGTH = 160

/** Booléen de query string : `true`/`1` ou `false`/`0`, absent = false. */
const flagSchema = z.stringbool({ truthy: ['true', '1'], falsy: ['false', '0'] }).default(false)

/** `GET /projects/:id/search` : texte (ou expression régulière JavaScript, flag `u`) et options. */
export const projectSearchQuerySchema = z.object({
  q: z.string().min(1).max(MAX_SEARCH_QUERY_LENGTH),
  caseSensitive: flagSchema,
  wholeWord: flagSchema,
  regex: flagSchema,
})
export type ProjectSearchQuery = z.infer<typeof projectSearchQuerySchema>

/**
 * Une occurrence. `line` commence à 1 ; `column` et `length` sont en unités UTF-16 dans la ligne,
 * à partir de 0 (directement utilisables par CodeMirror). `preview` est un extrait de la ligne
 * où l'occurrence commence à `previewStart`.
 */
export const projectSearchMatchSchema = z.object({
  documentId: z.uuid(),
  path: z.string(),
  line: z.number().int().positive(),
  column: z.number().int().nonnegative(),
  length: z.number().int().positive(),
  preview: z.string(),
  previewStart: z.number().int().nonnegative(),
})
export type ProjectSearchMatch = z.infer<typeof projectSearchMatchSchema>

/**
 * Réponse : occurrences dans l'ordre des chemins puis des positions. `truncated` : limite de
 * résultats atteinte ou temps de recherche dépassé (`timedOut`), d'autres occurrences peuvent
 * exister.
 */
export const projectSearchResponseSchema = z.object({
  matches: z.array(projectSearchMatchSchema),
  truncated: z.boolean(),
  timedOut: z.boolean(),
})
export type ProjectSearchResponse = z.infer<typeof projectSearchResponseSchema>
