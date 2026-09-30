import { type LogEntry } from '@kaxolax/contracts'
import { parseBibliographyLog } from './bibliography.js'
import { type LatexLogOptions, parseLatexLog } from './latex.js'

export { parseBiberLog, parseBibliographyLog, parseBibtexLog } from './bibliography.js'
export { type LatexLogOptions, parseLatexLog } from './latex.js'
export { DEFAULT_MAX_PRINT_LINE, logicalLines } from './lines.js'
export { normalizePath, type PathOptions } from './paths.js'

export const DEFAULT_MAX_ENTRIES = 1000

export interface CompileLogs {
  /** Log principal (`output.log`). */
  log: string | Uint8Array
  /** Log BibTeX ou Biber (`output.blg`), s'il existe. */
  blg?: string | Uint8Array | null
}

export interface CompileLogOptions extends LatexLogOptions {
  /** Nombre maximal d'entrées renvoyées (les suivantes sont ignorées). */
  maxEntries?: number
}

/** Entrées de toute une compilation : log LaTeX puis log bibliographique. */
export function parseCompileLogs(logs: CompileLogs, options: CompileLogOptions = {}): LogEntry[] {
  const entries = parseLatexLog(logs.log, options)
  if (logs.blg !== undefined && logs.blg !== null) {
    entries.push(...parseBibliographyLog(logs.blg, options))
  }
  return entries.slice(0, options.maxEntries ?? DEFAULT_MAX_ENTRIES)
}
