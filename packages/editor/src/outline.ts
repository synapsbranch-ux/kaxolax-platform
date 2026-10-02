import type { Text } from '@codemirror/state'
import {
  codeOf,
  groupEnd,
  INCOMPLETE,
  SECTION_LEVELS,
  type SectionCommand,
  skipSpaces,
  VERBATIM_ENVIRONMENTS,
} from './scan.js'

/** Titre de sectionnement trouvé dans un document. */
export interface OutlineHeading {
  kind: 'heading'
  /** 0 = `\part`, 1 = `\chapter`, 2 = `\section` … 6 = `\subparagraph`. */
  level: number
  command: SectionCommand
  /** Variante étoilée (`\section*`), non numérotée. */
  starred: boolean
  /** Titre lisible (formatage et `\label` retirés, maths conservées). */
  title: string
  /** Titre court de l'argument optionnel (`\section[court]{long}`). */
  shortTitle?: string
  /** Ligne (1 = première) et position de la commande dans son document. */
  line: number
  from: number
  /** Fichier du titre, renseigné par `expandOutline` (chemin donné par l'application). */
  file?: string
}

/** Inclusion d'un autre fichier (`\input`, `\include`, `\subfile`, `\import`…). */
export interface OutlineInclude {
  kind: 'include'
  command: string
  /** Chemin tel qu'écrit, `\import{dir/}{file}` donnant `dir/file`. */
  path: string
  line: number
  from: number
}

export type OutlineItem = OutlineHeading | OutlineInclude

/** Nœud du plan : un titre et les titres de niveau inférieur qui le suivent. */
export interface OutlineNode extends OutlineHeading {
  children: OutlineNode[]
}

const SECTION_NAMES = Object.keys(SECTION_LEVELS).join('|')
const INCLUDE_NAMES =
  'input|include|subfile|import|subimport|inputfrom|subinputfrom|includefrom|subincludefrom'
const VERBATIM_NAMES = VERBATIM_ENVIRONMENTS.map((name) => name.replace('*', '\\*')).join('|')

/** Commandes utiles au plan, dans l'ordre où elles apparaissent sur une ligne. */
const TOKEN = new RegExp(
  `\\\\(?:(${SECTION_NAMES})(\\*?)(?![a-zA-Z@])|(${INCLUDE_NAMES})(?![a-zA-Z@])|(documentclass)(?![a-zA-Z@])|(begin|end)\\{(document|${VERBATIM_NAMES})\\})`,
  'g',
)

/** Lignes suivantes lues au plus pour un titre écrit sur plusieurs lignes. */
const MAX_CONTINUATION_LINES = 10

interface Arguments {
  optional?: string
  required: string
  /** Ligne (indice) et colonne qui suivent le dernier argument. */
  endLine: number
  endColumn: number
}

/**
 * Lit `[optionnel]{obligatoire}` à partir de `start` dans `code` (code de la ligne `lineIndex`
 * à partir de la colonne `base`). Un argument peut continuer sur les lignes suivantes, jusqu'à une
 * ligne vide.
 */
function readArguments(
  lines: readonly string[],
  lineIndex: number,
  code: string,
  base: number,
  start: number,
): Arguments | null {
  let text = code.slice(start)
  // Début de chaque segment de `text` : ligne et colonne correspondantes.
  const segments = [{ at: 0, line: lineIndex, column: base + start }]
  for (let extra = 0; ; extra++) {
    let i = skipSpaces(text, 0)
    let optional: string | undefined
    let incomplete = false
    if (text[i] === '[') {
      const end = groupEnd(text, i)
      if (end === INCOMPLETE) incomplete = true
      else if (end < 0) return null
      else {
        optional = text.slice(i + 1, end - 1)
        i = skipSpaces(text, end)
      }
    }
    if (!incomplete && i < text.length) {
      if (text[i] !== '{') return null
      const end = groupEnd(text, i)
      if (end >= 0) {
        const segment = segments.findLast((candidate) => candidate.at <= end) ?? segments[0]
        if (!segment) return null
        return {
          ...(optional === undefined ? {} : { optional }),
          required: text.slice(i + 1, end - 1),
          endLine: segment.line,
          endColumn: segment.column + (end - segment.at),
        }
      }
      if (end !== INCOMPLETE) return null
    }
    const next = lineIndex + extra + 1
    const nextLine = lines[next]
    if (extra >= MAX_CONTINUATION_LINES || nextLine === undefined) return null
    const nextCode = codeOf(nextLine)
    // Une ligne vide termine le paragraphe : l'argument ne continue pas au-delà.
    if (nextCode.trim() === '') return null
    segments.push({ at: text.length + 1, line: next, column: 0 })
    text += '\n' + nextCode
  }
}

/** Remplacements des commandes de texte courantes dans un titre. */
const TEXT_COMMANDS: Record<string, string> = {
  LaTeX: 'LaTeX',
  LaTeXe: 'LaTeX2e',
  TeX: 'TeX',
  ldots: '…',
  dots: '…',
  textendash: '–',
  textemdash: '—',
  S: '§',
  P: '¶',
  oe: 'œ',
  OE: 'Œ',
  ae: 'æ',
  AE: 'Æ',
  ss: 'ß',
}

/** Commandes retirées d'un titre avec leurs arguments. */
const DROPPED_COMMANDS = new Set([
  'label',
  'index',
  'footnote',
  'footnotemark',
  'thanks',
  'hspace',
  'vspace',
  'cite',
])

/** Fin d'une formule qui commence à `start` (`$…$`, `$$…$$` ou `\(…\)`), fin du texte sinon. */
function mathEnd(text: string, start: number): number {
  const close = text.startsWith('\\(', start) ? '\\)' : text.startsWith('$$', start) ? '$$' : '$'
  for (let i = start + (close === '$' ? 1 : 2); i < text.length; i++) {
    if (text[i] === '\\') {
      if (close === '\\)' && text[i + 1] === ')') return i + 2
      i++
    } else if (close !== '\\)' && text.startsWith(close, i)) {
      return i + close.length
    }
  }
  return text.length
}

/**
 * Titre lisible : commandes de mise en forme retirées (leur texte est gardé), `\label`, `\footnote`
 * et `\index` supprimés, caractères échappés rétablis, espaces normalisés. Les formules sont
 * conservées telles quelles.
 */
export function cleanTitle(raw: string): string {
  let out = ''
  let i = 0
  while (i < raw.length) {
    const ch = raw.charAt(i)
    if (ch === '$' || raw.startsWith('\\(', i)) {
      const end = mathEnd(raw, i)
      out += raw.slice(i, end)
      i = end
    } else if (ch === '\\') {
      const name = /^[a-zA-Z@]+/.exec(raw.slice(i + 1))?.[0]
      if (name === undefined) {
        const next = raw.charAt(i + 1)
        // `\\`, `\,`, `\ ` : espace ; `\&`, `\%`, `\_`… : le caractère lui-même.
        out += next === '\\' || /[\s,;:!]/.test(next) ? ' ' : next
        i += 2
        continue
      }
      i += 1 + name.length
      if (raw[i] === '*') i++
      if (DROPPED_COMMANDS.has(name)) {
        let j = skipSpaces(raw, i)
        while (raw[j] === '[' || raw[j] === '{') {
          const end = groupEnd(raw, j)
          if (end < 0) break
          j = skipSpaces(raw, end)
          if (raw[end - 1] === '}') break
        }
        i = j
      } else {
        out += TEXT_COMMANDS[name] ?? ''
      }
    } else if (ch === '{' || ch === '}') {
      i++
    } else {
      out += ch === '~' ? ' ' : ch
      i++
    }
  }
  return out.replace(/\s+/g, ' ').trim()
}

/**
 * Titres et inclusions d'un document LaTeX, dans l'ordre. Ignore les commentaires, le contenu des
 * environnements verbatim, le préambule (entre `\documentclass` et `\begin{document}`) et ce qui
 * suit `\end{document}`. Linéaire en la taille du document.
 */
export function scanOutline(source: string | Text): OutlineItem[] {
  const lines = typeof source === 'string' ? source.split('\n') : source.toJSON()
  const items: OutlineItem[] = []
  let verbatimEnd: string | null = null
  let inPreamble = false
  let lineIndex = 0
  let lineStart = 0
  let column = 0

  const nextLine = (line: string) => {
    lineStart += line.length + 1
    lineIndex++
    column = 0
  }

  while (lineIndex < lines.length) {
    const raw = lines[lineIndex] ?? ''
    if (verbatimEnd !== null) {
      const end = raw.indexOf(verbatimEnd, column)
      if (end === -1) {
        nextLine(raw)
        continue
      }
      column = end + verbatimEnd.length
      verbatimEnd = null
    }
    if (!raw.includes('\\', column)) {
      nextLine(raw)
      continue
    }

    const code = codeOf(column === 0 ? raw : raw.slice(column))
    const base = column
    let jumped = false
    TOKEN.lastIndex = 0
    for (let match = TOKEN.exec(code); match !== null; match = TOKEN.exec(code)) {
      const from = lineStart + base + match.index
      const [, section, star, include, documentclass, beginEnd, environment] = match
      if (section !== undefined) {
        if (inPreamble) continue
        const args = readArguments(lines, lineIndex, code, base, TOKEN.lastIndex)
        if (args === null) continue
        const command = section as SectionCommand
        const title = cleanTitle(args.required)
        const shortTitle = args.optional === undefined ? '' : cleanTitle(args.optional)
        items.push({
          kind: 'heading',
          level: SECTION_LEVELS[command],
          command,
          starred: star === '*',
          title: title === '' ? args.required.trim() : title,
          ...(shortTitle === '' ? {} : { shortTitle }),
          line: lineIndex + 1,
          from,
        })
        if (args.endLine !== lineIndex) {
          // Titre sur plusieurs lignes : reprise juste après l'argument.
          for (let skipped = lineIndex; skipped < args.endLine; skipped++) {
            lineStart += (lines[skipped] ?? '').length + 1
          }
          lineIndex = args.endLine
          column = args.endColumn
          jumped = true
          break
        }
        TOKEN.lastIndex = args.endColumn - base
      } else if (include !== undefined) {
        if (inPreamble) continue
        const path = includePath(include, code, TOKEN.lastIndex)
        if (path === null) continue
        items.push({ kind: 'include', command: include, path, line: lineIndex + 1, from })
      } else if (documentclass !== undefined) {
        inPreamble = true
      } else if (environment === 'document') {
        if (beginEnd === 'end') return items
        inPreamble = false
      } else if (beginEnd === 'begin' && environment !== undefined) {
        verbatimEnd = `\\end{${environment}}`
        column = base + TOKEN.lastIndex
        jumped = true
        break
      }
    }
    if (!jumped) nextLine(raw)
  }
  return items
}

/** Chemin d'une commande d'inclusion (`\input{a}`, `\input a`, `\import{dir/}{a}`), ou null. */
function includePath(command: string, code: string, start: number): string | null {
  const i = skipSpaces(code, start)
  if (code[i] !== '{') {
    // Syntaxe TeX `\input fichier` : seulement pour \input.
    if (command !== 'input') return null
    const word = /^[^\s{}%\\]+/.exec(code.slice(i))?.[0]
    return word ?? null
  }
  const end = groupEnd(code, i)
  if (end < 0) return null
  const first = code.slice(i + 1, end - 1).trim()
  if (!/import|from/.test(command)) return first === '' ? null : first
  const j = skipSpaces(code, end)
  if (code[j] !== '{') return null
  const secondEnd = groupEnd(code, j)
  if (secondEnd < 0) return null
  const file = code.slice(j + 1, secondEnd - 1).trim()
  if (file === '') return null
  return first === '' ? file : `${first.replace(/\/+$/, '')}/${file}`
}

/** Construit l'arbre du plan : chaque titre devient l'enfant du dernier titre de niveau supérieur. */
export function buildOutlineTree(headings: readonly OutlineHeading[]): OutlineNode[] {
  const roots: OutlineNode[] = []
  const stack: OutlineNode[] = []
  for (const heading of headings) {
    const node: OutlineNode = { ...heading, children: [] }
    while (stack.length > 0 && (stack.at(-1)?.level ?? -1) >= node.level) stack.pop()
    const parent = stack.at(-1)
    if (parent) parent.children.push(node)
    else roots.push(node)
    stack.push(node)
  }
  return roots
}

/** Plan d'un document (sans descendre dans les fichiers inclus). */
export function extractOutline(source: string | Text): OutlineNode[] {
  return buildOutlineTree(
    scanOutline(source).filter((item): item is OutlineHeading => item.kind === 'heading'),
  )
}

/** Plan d'un fichier fourni par l'application pour une inclusion. */
export interface OutlineSource {
  file: string
  items: readonly OutlineItem[]
}

/**
 * Titres de plusieurs fichiers dans l'ordre de lecture : chaque inclusion est remplacée par les
 * titres du fichier que `resolve` renvoie (null : fichier introuvable, l'inclusion est ignorée).
 * Chaque titre reçoit `file`. Les inclusions circulaires et trop profondes sont ignorées.
 */
export function expandOutline(
  root: OutlineSource,
  resolve: (include: OutlineInclude, from: string) => OutlineSource | null,
  maxDepth = 8,
): OutlineHeading[] {
  const headings: OutlineHeading[] = []
  const visit = (source: OutlineSource, chain: readonly string[]) => {
    for (const item of source.items) {
      if (item.kind === 'heading') {
        headings.push({ ...item, file: source.file })
        continue
      }
      if (chain.length > maxDepth) continue
      const included = resolve(item, source.file)
      if (included === null || chain.includes(included.file)) continue
      visit(included, [...chain, included.file])
    }
  }
  visit(root, [root.file])
  return headings
}

/**
 * Noms de fichiers possibles pour une inclusion, dans l'ordre où LaTeX les essaie :
 * `\include` et `\subfile` ajoutent toujours `.tex`, `\input` essaie `x.tex` puis `x`.
 */
export function includeCandidates(include: Pick<OutlineInclude, 'command' | 'path'>): string[] {
  const path = include.path.replace(/^\.\//, '')
  if (path.endsWith('.tex')) return [path]
  return /^(input|import|subimport|inputfrom|subinputfrom)$/.test(include.command)
    ? [`${path}.tex`, path]
    : [`${path}.tex`]
}

/**
 * Chemin de la racine jusqu'à la section qui contient `position` : le dernier titre placé avant
 * (ou à) cette position, et ses ancêtres. Avec `file`, seuls les titres de ce fichier comptent
 * (plan de plusieurs fichiers construit par `expandOutline`). Tableau vide avant le premier titre.
 */
export function currentSectionPath(
  tree: readonly OutlineNode[],
  position: number,
  file?: string,
): OutlineNode[] {
  let best: OutlineNode[] = []
  let bestFrom = -1
  const stack: OutlineNode[] = []
  const visit = (nodes: readonly OutlineNode[]) => {
    for (const node of nodes) {
      stack.push(node)
      if (
        (file === undefined || node.file === file) &&
        node.from <= position &&
        node.from >= bestFrom
      ) {
        best = [...stack]
        bestFrom = node.from
      }
      visit(node.children)
      stack.pop()
    }
  }
  visit(tree)
  return best
}

/** Section qui contient `position` (voir `currentSectionPath`), ou null avant le premier titre. */
export function currentSection(
  tree: readonly OutlineNode[],
  position: number,
  file?: string,
): OutlineNode | null {
  return currentSectionPath(tree, position, file).at(-1) ?? null
}
