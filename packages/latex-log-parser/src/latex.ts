import { type LogEntry, type LogLevel, MAX_MISSING_FILE_LENGTH } from '@kaxolax/contracts'
import { DEFAULT_MAX_PRINT_LINE, logicalLines } from './lines.js'
import { normalizePath, type PathOptions } from './paths.js'

export interface LatexLogOptions extends Partial<PathOptions> {
  /** Largeur de coupure des lignes du log (max_print_line). */
  maxPrintLine?: number
}

/** Erreur au format -file-line-error : `./chapters/intro.tex:12: Message`. */
const FILE_LINE_ERROR = /^((?:\.{1,2}\/|\/)[^:]*|[^\s:/]+\.[A-Za-z0-9]+):(\d+): (.*)$/
/** Erreur au format classique : `! Message`. */
const CLASSIC_ERROR = /^! (.*)$/
/** Erreur Lua : `[\directlua]:1: attempt to index a nil value`. */
const LUA_ERROR = /^\[\\(?:direct|late)lua\]:\d+: (.*)$/
const LATEX_WARNING = /^((?:LaTeX|Package|Class|Module)\b[^:]*? Warning): (.*)$/
const ENGINE_WARNING = /^(?:pdfTeX|XeTeX|LuaTeX|LuaHBTeX|x?dvipdfmx)(?: warning|:warning)/
const MISSING_CHARACTER = 'Missing character: '
const BAD_BOX =
  /^(?:Over|Under)full \\[hv]box \(.*?\) (?:in paragraph at lines (\d+)--\d+|in alignment at lines (\d+)--\d+|detected at line (\d+)|has occurred while \\output is active)/
/** Ligne de suite d'un message multiligne : `(hyperref)      removing...`. */
const CONTINUATION = /^\(([^()\s]+)\)\s+(.*)$/
const INPUT_LINE = / on input line (\d+)\.?/
const CONTEXT_LINE = /^l\.(\d+) /
const FATAL_SUMMARY = '==> Fatal error occurred'
/**
 * Fichier introuvable : « LaTeX Error: File `xyz.sty' not found. » (\usepackage, \documentclass,
 * \input, identique sous pdfLaTeX, XeLaTeX et LuaLaTeX) ou « I can't find file `xyz'. » (primitive
 * \input de TeX).
 */
const MISSING_FILE =
  /(?:^|\s)(?:LaTeX Error: File `([^'`]+)' not found|I can't find file `([^'`]+)')/
/** Ouverture d'un fichier dans le log : `(./main.tex`, `(/usr/.../article.cls`, `("./a b.tex"`. */
const FILE_OPEN = /^\((?:"([^"]+)"|((?:\.{1,2}\/|\/)[^\s()"]*))/

/** Conséquences d'une erreur précédente, sans intérêt pour l'utilisateur. */
const CONSEQUENTIAL_STOPS = [
  'cannot \\read from terminal in nonstop modes',
  'job aborted, file error in nonstop mode',
]

const MAX_CONTEXT_LINES = 40

interface Frame {
  file: string | null
}

function isMessageStart(line: string): boolean {
  return (
    FILE_LINE_ERROR.test(line) ||
    CLASSIC_ERROR.test(line) ||
    LUA_ERROR.test(line) ||
    LATEX_WARNING.test(line) ||
    ENGINE_WARNING.test(line) ||
    line.startsWith(MISSING_CHARACTER) ||
    BAD_BOX.test(line)
  )
}

function clean(message: string): string {
  return message.replace(/\s+/g, ' ').trim()
}

/**
 * Parse le log principal d'une compilation LaTeX (pdfTeX, XeTeX ou LuaTeX) et renvoie ses
 * erreurs, warnings et bad boxes, avec le fichier et la ligne quand le log les donne.
 */
export function parseLatexLog(
  input: string | Uint8Array,
  options: LatexLogOptions = {},
): LogEntry[] {
  const pathOptions: PathOptions = {
    rootDir: options.rootDir ?? '/compile',
    jobname: options.jobname ?? 'output',
  }
  const lines = logicalLines(input, options.maxPrintLine ?? DEFAULT_MAX_PRINT_LINE)
  const entries: LogEntry[] = []
  const stack: Frame[] = []

  const currentFile = (): string | null => {
    for (let index = stack.length - 1; index >= 0; index--) {
      const frame = stack[index]
      if (frame?.file !== undefined && frame.file !== null) return frame.file
    }
    return null
  }

  const push = (
    level: LogLevel,
    file: string | null,
    line: number | null,
    message: string,
    raw: string[],
  ) => {
    const text = clean(message)
    const entry: LogEntry = { level, file, line, message: text, raw: raw.join('\n').trimEnd() }
    const missing = level === 'error' ? MISSING_FILE.exec(text) : null
    const missingFile = missing?.[1] ?? missing?.[2]
    // Nom démesuré (`\usepackage{<300 caractères>}`) : l'erreur reste affichée, sans suggestions,
    // pour que l'entrée reste valide au regard du contrat (sinon toute la réponse est refusée).
    if (missingFile !== undefined && missingFile.length <= MAX_MISSING_FILE_LENGTH) {
      entry.missingFile = missingFile
    }
    const last = entries.at(-1)
    // Un même message répété d'affilée (fontspec réessaie chaque forme) n'apparaît qu'une fois.
    if (
      last?.level === entry.level &&
      last.file === entry.file &&
      last.line === entry.line &&
      last.message === entry.message
    ) {
      return
    }
    entries.push(entry)
  }

  let index = 0
  while (index < lines.length) {
    const line = lines[index] ?? ''

    // Erreurs : première ligne, suites « (paquet) ... », puis contexte jusqu'au prochain message.
    const fileLine = FILE_LINE_ERROR.exec(line)
    const classic = fileLine ? null : CLASSIC_ERROR.exec(line)
    const lua = fileLine || classic ? null : LUA_ERROR.exec(line)
    if (fileLine || classic || lua) {
      let message = fileLine?.[3] ?? classic?.[1] ?? lua?.[1] ?? ''
      const raw = [line]
      let next = index + 1
      while (next < lines.length) {
        const continuation = CONTINUATION.exec(lines[next] ?? '')
        if (!continuation) break
        message += ` ${continuation[2] ?? ''}`
        raw.push(lines[next] ?? '')
        next++
      }
      // Contexte : des paires de lignes (« l.12 ... », « <*> main.tex », « <read *> »… puis leur
      // seconde moitié), puis le texte d'aide, qui se termine par une ligne vide.
      let contextLine: number | null = null
      let stopReason: string | null = null
      let markerSeen = false
      let skipNext = false
      let blank = 0
      for (let seen = 0; next < lines.length && seen < MAX_CONTEXT_LINES; seen++) {
        const context = lines[next] ?? ''
        if (skipNext) {
          skipNext = false
        } else {
          if (isMessageStart(context)) break
          const isBlank = context.trim() === ''
          if (isBlank && markerSeen) {
            next++
            break
          }
          blank = isBlank ? blank + 1 : 0
          if (blank >= 2) break
          const lineMatch = CONTEXT_LINE.exec(context)
          if (lineMatch) {
            contextLine ??= Number(lineMatch[1])
            markerSeen = true
            skipNext = true
          } else if (/^<[^>]*> ?/.test(context)) {
            markerSeen = true
            skipNext = true
          }
          const stop = /^\*\*\* \((.*)\)$/.exec(context)
          if (stop) stopReason = stop[1] ?? null
        }
        raw.push(context)
        next++
      }
      index = next

      const file = fileLine ? normalizePath(fileLine[1] ?? '', pathOptions) : currentFile()
      const lineNumber = fileLine ? Number(fileLine[2]) : contextLine

      // Résumé final au format -file-line-error (`./main.tex:2:  ==> Fatal error occurred…`) :
      // même traitement que sans préfixe, plus bas.
      if (clean(message).startsWith(FATAL_SUMMARY)) {
        if (!entries.some((entry) => entry.level === 'error')) {
          push('error', file, lineNumber, 'Fatal error occurred, no output PDF file produced!', raw)
        }
        continue
      }
      if (/^Emergency stop\.?$/.test(clean(message))) {
        const previous = entries.findLast((entry) => entry.level === 'error')
        const consequential =
          previous !== undefined &&
          (stopReason === null || CONSEQUENTIAL_STOPS.includes(stopReason))
        if (consequential) {
          // L'arrêt suit l'erreur qui l'explique : il donne souvent la ligne qui lui manquait.
          if (previous.line === null && lineNumber !== null) {
            previous.line = lineNumber
            previous.file ??= file
          }
          continue
        }
        if (stopReason !== null) message = stopReason
      }
      push('error', file, lineNumber, message, raw)
      continue
    }

    if (line.startsWith(FATAL_SUMMARY)) {
      if (!entries.some((entry) => entry.level === 'error')) {
        push('error', currentFile(), null, 'Fatal error occurred, no output PDF file produced!', [
          line,
        ])
      }
      index++
      continue
    }

    // Warnings LaTeX, de paquet ou de classe, avec leurs lignes de suite.
    const warning = LATEX_WARNING.exec(line)
    if (warning) {
      const prefix = warning[1] ?? ''
      let message = prefix === 'LaTeX Warning' ? (warning[2] ?? '') : line
      const raw = [line]
      let next = index + 1
      while (next < lines.length) {
        const text = lines[next] ?? ''
        const continuation = CONTINUATION.exec(text)
        if (continuation) message += ` ${continuation[2] ?? ''}`
        else if (/^\s+\S/.test(text)) message += ` ${text.trim()}`
        else break
        raw.push(text)
        next++
      }
      const inputLine = INPUT_LINE.exec(message)
      message = message.replace(INPUT_LINE, '')
      push('warning', currentFile(), inputLine ? Number(inputLine[1]) : null, message, raw)
      index = next
      continue
    }

    if (ENGINE_WARNING.test(line) || line.startsWith(MISSING_CHARACTER)) {
      push('warning', currentFile(), null, line, [line])
      index++
      continue
    }

    // Bad boxes : le contenu de la boîte suit jusqu'à la prochaine ligne vide.
    const badBox = BAD_BOX.exec(line)
    if (badBox) {
      const raw = [line]
      let next = index + 1
      while (next < lines.length && (lines[next] ?? '').trim() !== '') {
        raw.push(lines[next] ?? '')
        next++
      }
      const lineNumber = badBox[1] ?? badBox[2] ?? badBox[3]
      push('typesetting', currentFile(), lineNumber ? Number(lineNumber) : null, line, raw)
      index = next
      continue
    }

    // Ni message ni suite : on suit l'ouverture et la fermeture des fichiers.
    if (!CONTINUATION.test(line)) {
      for (let position = 0; position < line.length; position++) {
        const character = line[position]
        if (character === '(') {
          const open = FILE_OPEN.exec(line.slice(position))
          if (open) {
            const path = open[1] ?? open[2] ?? ''
            stack.push({ file: normalizePath(path, pathOptions) })
            position += open[0].length - 1
          } else {
            stack.push({ file: null })
          }
        } else if (character === ')') {
          stack.pop()
        }
      }
    }
    index++
  }
  return entries
}
