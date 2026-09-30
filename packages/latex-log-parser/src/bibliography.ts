import { type LogEntry } from '@kaxolax/contracts'
import { plainLines } from './lines.js'
import { normalizePath, type PathOptions } from './paths.js'

const DEFAULT_PATHS: PathOptions = { rootDir: '/compile', jobname: 'output' }

function entry(
  level: LogEntry['level'],
  file: string | null,
  line: number | null,
  message: string,
  raw: string[],
): LogEntry {
  return { level, file, line, message: message.replace(/\s+/g, ' ').trim(), raw: raw.join('\n') }
}

/** Log de BibTeX (`output.blg`). */
export function parseBibtexLog(
  input: string | Uint8Array,
  options: Partial<PathOptions> = {},
): LogEntry[] {
  const paths = { ...DEFAULT_PATHS, ...options }
  const lines = plainLines(input)
  const entries: LogEntry[] = []

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index] ?? ''

    const warning = /^Warning--(.*)$/.exec(line)
    if (warning) {
      const location = /^--line (\d+) of file (.+)$/.exec(lines[index + 1] ?? '')
      if (location) {
        entries.push(
          entry(
            'warning',
            normalizePath(location[2] ?? '', paths),
            Number(location[1]),
            warning[1] ?? '',
            [line, lines[index + 1] ?? ''],
          ),
        )
        index++
      } else {
        entries.push(entry('warning', null, null, warning[1] ?? '', [line]))
      }
      continue
    }

    // Erreur de syntaxe : « I was expecting a `,' or a `}'---line 9 of file refs.bib », suivie
    // de lignes de contexte (« : ... », « I'm skipping whatever remains of this entry »).
    const atLine = /^(.*?)-{3}line (\d+) of file (.+)$/.exec(line)
    if (atLine) {
      const raw = [line]
      while (
        index + 1 < lines.length &&
        /^( : |\(Error may have been|I'm skipping)/.test(lines[index + 1] ?? '')
      ) {
        raw.push(lines[index + 1] ?? '')
        index++
      }
      entries.push(
        entry(
          'error',
          normalizePath(atLine[3] ?? '', paths),
          Number(atLine[2]),
          atLine[1] ?? '',
          raw,
        ),
      )
      continue
    }

    const whileReading = /^(.*?)-{3}while reading file (.+)$/.exec(line)
    if (whileReading) {
      entries.push(
        entry('error', normalizePath(whileReading[2] ?? '', paths), null, whileReading[1] ?? '', [
          line,
        ]),
      )
      continue
    }

    const cannotOpen = /^I couldn't open (?:database|style|auxiliary) file (.+)$/.exec(line)
    if (cannotOpen) {
      entries.push(entry('error', normalizePath(cannotOpen[1] ?? '', paths), null, line, [line]))
    }
  }
  return entries
}

/** Log de Biber (`output.blg`). */
export function parseBiberLog(
  input: string | Uint8Array,
  options: Partial<PathOptions> = {},
): LogEntry[] {
  const paths = { ...DEFAULT_PATHS, ...options }
  const entries: LogEntry[] = []
  let dataSource: string | null = null

  for (const line of plainLines(input)) {
    const source = /INFO - (?:Found BibTeX data source|Looking for bibtex file) '([^']+)'/.exec(
      line,
    )
    if (source) {
      dataSource = normalizePath(source[1] ?? '', paths)
      continue
    }
    const message = /^\[\d+\] [^>]*> (WARN|ERROR|FATAL) - (.*)$/.exec(line)
    if (!message) continue
    const level = message[1] === 'WARN' ? 'warning' : 'error'
    const text = message[2] ?? ''

    // Biber analyse une copie UTF-8 temporaire du .bib : on rattache l'erreur à la source lue.
    const subsystem = /^BibTeX subsystem: [^,]+, line (\d+), (.*)$/.exec(text)
    if (subsystem) {
      entries.push(entry(level, dataSource, Number(subsystem[1]), subsystem[2] ?? '', [line]))
    } else {
      entries.push(entry(level, null, null, text, [line]))
    }
  }
  return entries
}

/** Choisit le parser selon le contenu du .blg (BibTeX ou Biber). */
export function parseBibliographyLog(
  input: string | Uint8Array,
  options: Partial<PathOptions> = {},
): LogEntry[] {
  const text = typeof input === 'string' ? input : new TextDecoder('utf-8').decode(input)
  return /^\[\d+\] /m.test(text) && !/^This is (?:8-bit Big )?BibTeX/m.test(text)
    ? parseBiberLog(text, options)
    : parseBibtexLog(text, options)
}
