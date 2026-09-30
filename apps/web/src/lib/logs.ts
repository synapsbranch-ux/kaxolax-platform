import type { LogEntry } from '@kaxolax/contracts'

export interface GroupedEntries {
  errors: LogEntry[]
  warnings: LogEntry[]
  typesetting: LogEntry[]
}

/** Entrées du log groupées par niveau, dans l'ordre du log. */
export function groupEntries(entries: readonly LogEntry[]): GroupedEntries {
  return {
    errors: entries.filter((entry) => entry.level === 'error'),
    warnings: entries.filter((entry) => entry.level === 'warning'),
    typesetting: entries.filter((entry) => entry.level === 'typesetting'),
  }
}

export function locationLabel(entry: LogEntry): string | null {
  if (entry.file === null) return null
  return entry.line === null ? entry.file : `${entry.file}:${String(entry.line)}`
}
