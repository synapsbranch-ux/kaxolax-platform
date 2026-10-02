import type { Text } from '@codemirror/state'
import { codeOf, VERBATIM_ENVIRONMENTS } from '../scan.js'

/** Texte d'un document CodeMirror ou d'une chaîne. */
export function textOf(doc: Text | string): string {
  return typeof doc === 'string' ? doc : doc.toString()
}

/** Code d'un document : commentaires et verbatim remplacés par des espaces, positions identiques. */
export interface MaskedCode {
  text: string
  code: string
  /** Commentaires (`%` jusqu'à la fin de ligne, sans le saut de ligne), dans l'ordre. */
  comments: [number, number][]
}

const VERBATIM_BEGIN = new RegExp(
  `\\\\begin\\s*\\{(${VERBATIM_ENVIRONMENTS.map((name) => name.replace('*', '\\*')).join('|')})\\}`,
)

/**
 * Masque les commentaires, le contenu de `\verb|…|` et des environnements verbatim : les outils
 * d'écriture cherchent formules et tableaux dans le code seul, sans décaler les positions.
 */
export function maskCode(doc: Text | string): MaskedCode {
  const text = textOf(doc)
  const parts: string[] = []
  const comments: [number, number][] = []
  let offset = 0
  let verbatimEnd: string | null = null
  while (offset <= text.length) {
    const newline = text.indexOf('\n', offset)
    const lineEnd = newline === -1 ? text.length : newline
    const line = text.slice(offset, lineEnd)
    let masked: string
    if (verbatimEnd !== null) {
      const end = line.indexOf(verbatimEnd)
      if (end === -1) masked = ' '.repeat(line.length)
      else {
        const tail = line.slice(end + verbatimEnd.length)
        masked = ' '.repeat(end) + verbatimEnd + codeOf(tail)
        verbatimEnd = null
      }
    } else {
      masked = codeOf(line)
      const verbatim = VERBATIM_BEGIN.exec(masked)
      if (verbatim?.[1] !== undefined) {
        const after = verbatim.index + verbatim[0].length
        const close = `\\end{${verbatim[1]}}`
        const end = line.indexOf(close, after)
        if (end === -1) {
          masked = masked.slice(0, after)
          verbatimEnd = close
        } else {
          masked = masked.slice(0, after) + ' '.repeat(end - after) + codeOf(line.slice(end))
        }
      }
    }
    // Un commentaire commence là où le code s'arrête sur un `%` (hors verbatim).
    if (masked.length < line.length && verbatimEnd === null && line[masked.length] === '%') {
      comments.push([offset + masked.length, lineEnd])
    }
    parts.push(masked.padEnd(line.length, ' '))
    if (newline === -1) break
    parts.push('\n')
    offset = newline + 1
  }
  return { text, code: parts.join(''), comments }
}

/** Environnement `\begin{name}` … `\end{name}` trouvé dans le code. */
export interface EnvironmentRange {
  name: string
  /** Début de `\begin`, fin de `\end{name}`. */
  from: number
  to: number
  /** Fin de `\begin{name}` et début de `\end{name}`. */
  beginTo: number
  endFrom: number
}

const BEGIN_END = /\\(begin|end)\s*\{([^{}]*)\}/g

/** Environnements bien fermés du code masqué, dans l'ordre de leur `\begin`. */
export function environments(code: string): EnvironmentRange[] {
  const stack: { name: string; from: number; beginTo: number }[] = []
  const found: EnvironmentRange[] = []
  BEGIN_END.lastIndex = 0
  for (let match = BEGIN_END.exec(code); match !== null; match = BEGIN_END.exec(code)) {
    const name = match[2]?.trim() ?? ''
    if (match[1] === 'begin') {
      stack.push({ name, from: match.index, beginTo: match.index + match[0].length })
      continue
    }
    // `\end` sans `\begin` correspondant : on remonte jusqu'à l'environnement de même nom.
    const index = stack.map((open) => open.name).lastIndexOf(name)
    if (index === -1) continue
    const open = stack[index]
    stack.length = index
    if (open === undefined) continue
    found.push({
      name,
      from: open.from,
      to: match.index + match[0].length,
      beginTo: open.beginTo,
      endFrom: match.index,
    })
  }
  return found.sort((a, b) => a.from - b.from)
}

/** Texte d'une plage dont les commentaires sont retirés (sauts de ligne conservés). */
export function withoutComments(masked: MaskedCode, from: number, to: number): string {
  let out = ''
  let position = from
  for (const [start, end] of masked.comments) {
    if (end <= from || start >= to) continue
    out += masked.text.slice(position, Math.max(position, start))
    position = Math.max(position, Math.min(end, to))
  }
  return out + masked.text.slice(position, to)
}

/** Vrai si la plage contient un commentaire. */
export function hasComment(masked: MaskedCode, from: number, to: number): boolean {
  return masked.comments.some(([start, end]) => start < to && end > from)
}
