import { foldService } from '@codemirror/language'
import type { EditorState } from '@codemirror/state'

/** Niveaux des commandes de sectionnement : une section se replie jusqu'à la suivante de même niveau ou plus haut. */
const SECTION_LEVELS: Record<string, number> = {
  part: 0,
  chapter: 1,
  section: 2,
  subsection: 3,
  subsubsection: 4,
  paragraph: 5,
  subparagraph: 6,
}

const BEGIN = /^\s*\\begin\{([^}]+)\}/
const SECTION =
  /^\s*\\(part|chapter|section|subsection|subsubsection|paragraph|subparagraph)\*?[[{]/
const ENVIRONMENT = /\\(begin|end)\{([^}]+)\}/g

/** Retire un commentaire de fin de ligne (`%` non échappé). */
function code(text: string): string {
  const match = /(^|[^\\])%/.exec(text)
  return match ? text.slice(0, match.index + (match[1] ?? '').length) : text
}

/**
 * Zone repliable qui commence à la ligne `lineStart` : un environnement `\begin{x}…\end{x}`
 * (imbrications comprises), ou une section jusqu'à la suivante de même niveau ou plus haut.
 */
export function findFoldRange(
  state: EditorState,
  lineStart: number,
): { from: number; to: number } | null {
  const line = state.doc.lineAt(lineStart)
  const text = code(line.text)

  const begin = BEGIN.exec(text)
  if (begin?.[1]) {
    const name = begin[1]
    let depth = 0
    for (let number = line.number; number <= state.doc.lines; number++) {
      const current = state.doc.line(number)
      for (const match of code(current.text).matchAll(ENVIRONMENT)) {
        if (match[2] !== name) continue
        depth += match[1] === 'begin' ? 1 : -1
        if (depth === 0) {
          return number === line.number
            ? null
            : { from: line.to, to: state.doc.line(number - 1).to }
        }
      }
    }
    return null
  }

  const section = SECTION.exec(text)
  if (section?.[1]) {
    const level = SECTION_LEVELS[section[1]] ?? 0
    let end = state.doc.lines
    for (let number = line.number + 1; number <= state.doc.lines; number++) {
      const current = code(state.doc.line(number).text)
      const next = SECTION.exec(current)
      if (
        (next?.[1] && (SECTION_LEVELS[next[1]] ?? 0) <= level) ||
        /^\s*\\end\{document\}/.test(current)
      ) {
        end = number - 1
        break
      }
    }
    // Les lignes vides juste avant la section suivante restent visibles.
    while (end > line.number && state.doc.line(end).text.trim() === '') end--
    return end > line.number ? { from: line.to, to: state.doc.line(end).to } : null
  }
  return null
}

export const latexFolding = foldService.of((state, lineStart) => findFoldRange(state, lineStart))
