import { z } from 'zod'

export const logLevelSchema = z.enum(['error', 'warning', 'typesetting'])
export type LogLevel = z.infer<typeof logLevelSchema>

/** Longueur maximale de `LogEntry.missingFile` (nom de fichier usuel des systèmes de fichiers). */
export const MAX_MISSING_FILE_LENGTH = 255

/**
 * Une entrée du log LaTeX parsé ; `file` et `line` sont nuls si le log ne les donne pas.
 * `missingFile` : fichier introuvable d'une erreur « File `xyz.sty' not found » (`xyz.sty`,
 * `xyz.cls`, `chapitre.tex`…), pour proposer les packages proches (`/texlive/suggestions`) ;
 * absent si le nom dépasse `MAX_MISSING_FILE_LENGTH` (l'erreur reste dans `message`).
 */
export const logEntrySchema = z.object({
  level: logLevelSchema,
  file: z.string().nullable(),
  line: z.number().int().positive().nullable(),
  message: z.string(),
  raw: z.string(),
  missingFile: z.string().min(1).max(MAX_MISSING_FILE_LENGTH).optional(),
})
export type LogEntry = z.infer<typeof logEntrySchema>
