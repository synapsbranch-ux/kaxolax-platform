import { z } from 'zod'

export const logLevelSchema = z.enum(['error', 'warning', 'typesetting'])
export type LogLevel = z.infer<typeof logLevelSchema>

/** Une entrée du log LaTeX parsé ; `file` et `line` sont nuls si le log ne les donne pas. */
export const logEntrySchema = z.object({
  level: logLevelSchema,
  file: z.string().nullable(),
  line: z.number().int().positive().nullable(),
  message: z.string(),
  raw: z.string(),
})
export type LogEntry = z.infer<typeof logEntrySchema>
