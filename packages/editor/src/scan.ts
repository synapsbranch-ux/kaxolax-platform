/** Niveaux des commandes de sectionnement (0 = `\part` … 6 = `\subparagraph`). */
export const SECTION_LEVELS = {
  part: 0,
  chapter: 1,
  section: 2,
  subsection: 3,
  subsubsection: 4,
  paragraph: 5,
  subparagraph: 6,
} as const

export type SectionCommand = keyof typeof SECTION_LEVELS

/** Environnements dont le contenu n'est pas du LaTeX (aucune commande n'y est lue). */
export const VERBATIM_ENVIRONMENTS = [
  'verbatim',
  'verbatim*',
  'Verbatim',
  'Verbatim*',
  'BVerbatim',
  'LVerbatim',
  'lstlisting',
  'minted',
  'comment',
  'filecontents',
  'filecontents*',
] as const

const BACKSLASH = 92
const OPEN_BRACE = 123
const CLOSE_BRACE = 125
const OPEN_BRACKET = 91
const CLOSE_BRACKET = 93

const INLINE_VERBATIM = /\\(?:verb\*?|lstinline(?:\[[^\]]*\])?)(?![a-zA-Z@])/y

/** Vrai si le caractère à `index` est précédé d'un nombre impair de `\` (caractère échappé). */
function escaped(text: string, index: number): boolean {
  let count = 0
  for (let i = index - 1; i >= 0 && text.charCodeAt(i) === BACKSLASH; i--) count++
  return count % 2 === 1
}

/**
 * Partie « code » d'une ligne : le commentaire (`%` non échappé) est retiré et le contenu de
 * `\verb|…|` ou `\lstinline|…|` est remplacé par des espaces. Les positions restent celles de la
 * ligne d'origine.
 */
export function codeOf(line: string): string {
  if (!line.includes('\\verb') && !line.includes('\\lstinline')) {
    // Cas courant : seule la recherche du commentaire est utile.
    let index = line.indexOf('%')
    while (index !== -1 && escaped(line, index)) index = line.indexOf('%', index + 1)
    return index === -1 ? line : line.slice(0, index)
  }
  let out = ''
  let i = 0
  while (i < line.length) {
    const code = line.charCodeAt(i)
    if (code === 37 /* % */) return out
    if (code !== BACKSLASH) {
      out += line.charAt(i)
      i++
      continue
    }
    INLINE_VERBATIM.lastIndex = i
    if (INLINE_VERBATIM.test(line)) {
      const open = INLINE_VERBATIM.lastIndex
      const delimiter = line[open]
      if (delimiter === undefined) return out + line.slice(i)
      const close = line.indexOf(delimiter === '{' ? '}' : delimiter, open + 1)
      const end = close === -1 ? line.length : close
      out += line.slice(i, open + 1) + ' '.repeat(Math.max(0, end - open - 1))
      if (close !== -1) out += line.charAt(close)
      i = end + 1
      continue
    }
    out += line.slice(i, i + 2)
    i += 2
  }
  return out
}

/** Fin d'un groupe introuvable : texte terminé avant la fermeture. */
export const INCOMPLETE = -1
/** Groupe mal formé (accolade fermante en trop dans un argument optionnel). */
export const MALFORMED = -2

/**
 * Fin d'un groupe `{…}` ou `[…]` qui commence à `start` : indice qui suit la fermeture,
 * `INCOMPLETE` si le texte s'arrête avant, `MALFORMED` si le groupe est invalide. Les accolades
 * s'imbriquent, `\{` et `\}` sont ignorés, un `]` entre accolades ne ferme pas un argument optionnel.
 */
export function groupEnd(text: string, start: number): number {
  const open = text.charCodeAt(start)
  if (open !== OPEN_BRACE && open !== OPEN_BRACKET) return MALFORMED
  let braces = 0
  for (let i = start + 1; i < text.length; i++) {
    const code = text.charCodeAt(i)
    if (code === BACKSLASH) {
      i++
    } else if (code === OPEN_BRACE) {
      braces++
    } else if (code === CLOSE_BRACE) {
      if (braces > 0) braces--
      else return open === OPEN_BRACE ? i + 1 : MALFORMED
    } else if (code === CLOSE_BRACKET && open === OPEN_BRACKET && braces === 0) {
      return i + 1
    }
  }
  return INCOMPLETE
}

/** Indice du premier caractère non blanc à partir de `index` (fin du texte sinon). */
export function skipSpaces(text: string, index: number): number {
  let i = index
  while (i < text.length && /\s/.test(text.charAt(i))) i++
  return i
}

/** Découpe une liste séparée par des virgules (hors accolades), éléments rognés, vides retirés. */
export function splitList(text: string): string[] {
  const items: string[] = []
  let depth = 0
  let start = 0
  for (let i = 0; i <= text.length; i++) {
    const code = i < text.length ? text.charCodeAt(i) : 44
    if (code === BACKSLASH) i++
    else if (code === OPEN_BRACE) depth++
    else if (code === CLOSE_BRACE) depth = Math.max(0, depth - 1)
    else if (code === 44 /* , */ && depth === 0) {
      const item = text.slice(start, i).trim()
      if (item !== '') items.push(item)
      start = i + 1
    }
  }
  return items
}

/** Indentation (espaces et tabulations) en tête de ligne. */
export function indentationOf(line: string): string {
  return /^[ \t]*/.exec(line)?.[0] ?? ''
}
