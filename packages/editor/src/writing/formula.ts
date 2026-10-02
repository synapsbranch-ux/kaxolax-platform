import type { Text } from '@codemirror/state'
import { groupEnd } from '../scan.js'
import { maskCode } from './mask.js'
import { latexCommentStart, stripLatexComments } from './mathlive.js'

/** Environnements mathématiques reconnus par l'éditeur de formules. */
export const MATH_ENVIRONMENTS = [
  'equation',
  'equation*',
  'align',
  'align*',
  'gather',
  'gather*',
  'multline',
  'multline*',
  'flalign',
  'flalign*',
  'displaymath',
  'math',
] as const

export type MathEnvironment = (typeof MATH_ENVIRONMENTS)[number]

/** Environnements numérotés (une équation ou une ligne = un numéro). */
const NUMBERED = new Set<string>(['equation', 'align', 'gather', 'multline', 'flalign'])

/** Environnements qui demandent amsmath. */
export const AMSMATH_ENVIRONMENTS = new Set<string>([
  'equation*',
  'align',
  'align*',
  'gather',
  'gather*',
  'multline',
  'multline*',
  'flalign',
  'flalign*',
])

/** Environnements à plusieurs lignes : MathLive les édite dans `aligned` ou `gathered`. */
const EDITOR_WRAPPERS: Partial<Record<string, 'aligned' | 'gathered'>> = {
  align: 'aligned',
  'align*': 'aligned',
  flalign: 'aligned',
  'flalign*': 'aligned',
  gather: 'gathered',
  'gather*': 'gathered',
  multline: 'gathered',
  'multline*': 'gathered',
}

export type FormulaDelimiter = '\\(' | '\\[' | '$' | '$$' | 'environment'

/** Présentation d'une formule : en ligne, centrée sans numéro, ou numérotée. */
export type FormulaStyle = 'inline' | 'display' | 'equation'

/** Formule trouvée dans le document (positions absolues). */
export interface FormulaMatch {
  delimiter: FormulaDelimiter
  /** Nom de l'environnement (`align*`) si `delimiter` vaut `environment`. */
  environment?: string
  style: FormulaStyle
  /** Toute la formule, délimiteurs compris. */
  from: number
  to: number
  text: string
  /** Contenu entre les délimiteurs. */
  contentFrom: number
  contentTo: number
  /** Formule proprement dite : contenu rogné, sans le `\label` de tête ou de fin. */
  body: string
  bodyFrom: number
  bodyTo: number
  /** `\label{…}` unique en tête ou en fin du contenu (environnement numéroté). */
  label?: { name: string; from: number; to: number }
}

interface OpenMath {
  delimiter: FormulaDelimiter
  environment?: string
  from: number
  contentFrom: number
}

const LETTER = /[a-zA-Z@]/

/** Fermeture attendue pour une formule ouverte. */
function closes(open: OpenMath, token: string, environment: string | undefined): boolean {
  switch (open.delimiter) {
    case '\\(':
      return token === '\\)'
    case '\\[':
      return token === '\\]'
    case '$':
      return token === '$'
    case '$$':
      return token === '$$'
    case 'environment':
      return token === '\\end' && environment === open.environment
  }
}

/**
 * Formules du document, dans l'ordre : `\( \)`, `\[ \]`, `$ $`, `$$ $$` et environnements
 * mathématiques (`MATH_ENVIRONMENTS`). Commentaires et verbatim ignorés ; une formule en ligne
 * interrompue par une ligne vide (erreur LaTeX) est abandonnée.
 */
export function findFormulas(doc: Text | string): FormulaMatch[] {
  const masked = maskCode(doc)
  const { code, text } = masked
  const found: FormulaMatch[] = []
  let open: OpenMath | null = null
  let i = 0
  while (i < code.length) {
    const ch = code[i]
    let token: string | null = null
    let environment: string | undefined
    const start = i
    if (ch === '\\') {
      const next = code[i + 1] ?? ''
      if (LETTER.test(next)) {
        let end = i + 2
        while (end < code.length && LETTER.test(code[end] ?? '')) end++
        const name = code.slice(i + 1, end)
        i = end
        if (name === 'begin' || name === 'end') {
          let brace = i
          while (code[brace] === ' ') brace++
          if (code[brace] === '{') {
            const close = groupEnd(code, brace)
            if (close > 0) {
              environment = code.slice(brace + 1, close - 1).trim()
              token = `\\${name}`
              i = close
            }
          }
        }
      } else {
        token = `\\${next}`
        i += 2
      }
    } else if (ch === '$') {
      token = code[i + 1] === '$' ? '$$' : '$'
      i += token.length
    } else if (ch === '\n' && open !== null && open.delimiter !== 'environment') {
      // Ligne vide dans une formule en ligne ou centrée : erreur LaTeX, on abandonne.
      if (/^\n[ \t]*\n/.test(code.slice(i, i + 200))) open = null
      i++
      continue
    } else {
      i++
      continue
    }
    if (token === null) continue

    if (open === null) {
      if (token === '\\(' || token === '\\[' || token === '$' || token === '$$') {
        open = { delimiter: token, from: start, contentFrom: i }
      } else if (
        token === '\\begin' &&
        environment !== undefined &&
        (MATH_ENVIRONMENTS as readonly string[]).includes(environment)
      ) {
        open = { delimiter: 'environment', environment, from: start, contentFrom: i }
      }
      continue
    }
    if (closes(open, token, environment)) {
      found.push(buildMatch(text, code, open, start, i))
      open = null
    }
  }
  return found
}

function styleOf(delimiter: FormulaDelimiter, environment: string | undefined): FormulaStyle {
  if (delimiter === '\\(' || delimiter === '$') return 'inline'
  if (delimiter === 'environment') {
    if (environment === 'math') return 'inline'
    return environment !== undefined && NUMBERED.has(environment) ? 'equation' : 'display'
  }
  return 'display'
}

const LABEL_AT_START = /^\\label\s*\{([^{}]*)\}/
const LABEL_AT_END = /\\label\s*\{([^{}]*)\}$/

function buildMatch(
  text: string,
  code: string,
  open: OpenMath,
  contentTo: number,
  to: number,
): FormulaMatch {
  const { contentFrom } = open
  const content = text.slice(contentFrom, contentTo)
  const lead = content.length - content.trimStart().length
  const trail = content.length - content.trimEnd().length
  let bodyFrom = contentFrom + lead
  let bodyTo = Math.max(bodyFrom, contentTo - trail)
  const style = styleOf(open.delimiter, open.environment)
  let label: FormulaMatch['label']
  const labels = code.slice(contentFrom, contentTo).match(/\\label(?![a-zA-Z@])/g)?.length ?? 0
  if (labels === 1) {
    const trimmed = text.slice(bodyFrom, bodyTo)
    const atStart = LABEL_AT_START.exec(trimmed)
    const atEnd = atStart ? null : LABEL_AT_END.exec(trimmed)
    if (atStart?.[1] !== undefined) {
      label = { name: atStart[1], from: bodyFrom, to: bodyFrom + atStart[0].length }
      bodyFrom = label.to
      while (bodyFrom < bodyTo && /\s/.test(text.charAt(bodyFrom))) bodyFrom++
    } else if (atEnd?.[1] !== undefined) {
      label = { name: atEnd[1], from: bodyTo - atEnd[0].length, to: bodyTo }
      bodyTo = label.from
      while (bodyTo > bodyFrom && /\s/.test(text.charAt(bodyTo - 1))) bodyTo--
    }
  }
  return {
    delimiter: open.delimiter,
    ...(open.environment === undefined ? {} : { environment: open.environment }),
    style,
    from: open.from,
    to,
    text: text.slice(open.from, to),
    contentFrom,
    contentTo,
    body: text.slice(bodyFrom, bodyTo),
    bodyFrom,
    bodyTo,
    ...(label ? { label } : {}),
  }
}

/**
 * Formule sous le curseur (ou qui contient toute la sélection `from`–`to`), ou null. Une formule en
 * ligne doit contenir strictement la position ; une formule centrée la contient aussi sur ses
 * délimiteurs.
 */
export function formulaAt(doc: Text | string, from: number, to = from): FormulaMatch | null {
  for (const match of findFormulas(doc)) {
    if (match.from > to) break
    const inside =
      match.style === 'inline'
        ? match.from < from && to < match.to
        : match.from <= from && to <= match.to
    if (inside) return match
  }
  return null
}

/** Commande dont l'argument repasse en mode texte dans une formule (`\\text{…}`). */
export const TEXT_ARGUMENT =
  /^\\(?:text(?:rm|it|bf|sf|tt|up|sl|sc|normal)?|emph|mbox|hbox|intertext|shortintertext)\s*\{/

/**
 * Vrai si toute la plage `from`–`to` est en mode mathématique : dans le contenu d'une formule
 * (jamais sur ses délimiteurs ni juste avant ou après), hors d'un `\\text{…}`. Un symbole
 * mathématique s'y insère sans `\\( \\)`.
 */
export function mathModeAt(doc: Text | string, from: number, to = from): boolean {
  const match = findFormulas(doc).find(
    (formula) => formula.contentFrom <= from && to <= formula.contentTo,
  )
  if (match === undefined) return false
  // Groupes ouverts avant la position : un groupe texte ouvert repasse en mode texte.
  const code = maskCode(doc).code
  const groups: boolean[] = []
  for (let i = match.contentFrom; i < from; i++) {
    const ch = code[i]
    if (ch === '\\') {
      const open = TEXT_ARGUMENT.exec(code.slice(i, i + 40))
      if (open !== null) {
        groups.push(true)
        i += open[0].length - 1
      } else i++
    } else if (ch === '{') groups.push(false)
    else if (ch === '}') groups.pop()
  }
  return !groups.includes(true)
}

/** Vrai si la position est en mode mathématique (dans une formule, délimiteurs exclus). */
export function inMath(doc: Text | string, position: number): boolean {
  return findFormulas(doc).some(
    (match) => match.contentFrom <= position && position <= match.contentTo,
  )
}

/**
 * Découpe un texte au niveau supérieur (hors accolades et environnements) : vrai s'il contient
 * `token` (`\\` ou `&`) hors de tout groupe.
 */
export function hasTopLevel(latex: string, token: '\\\\' | '&'): boolean {
  let depth = 0
  for (let i = 0; i < latex.length; i++) {
    const ch = latex[i]
    if (ch === '\\') {
      const rest = latex.slice(i)
      if (/^\\begin(?![a-zA-Z])/.test(rest)) depth++
      else if (/^\\end(?![a-zA-Z])/.test(rest)) depth--
      else if (token === '\\\\' && latex[i + 1] === '\\' && depth === 0) return true
      i++
    } else if (ch === '{') depth++
    else if (ch === '}') depth--
    else if (ch === '&' && token === '&' && depth === 0) return true
  }
  return false
}

export interface FormulaInput {
  /** LaTeX de la formule (déjà normalisé, voir `normalizeMathLive`). */
  body: string
  style: FormulaStyle
  /** `\label` d'une équation numérotée (ignoré sinon) ; vide : pas de label. */
  label?: string
}

/** Indentation d'une ligne de contenu dans les blocs produits (une tabulation = un niveau). */
const INDENT = '\t'

/** Vrai si la dernière ligne du texte se termine par un commentaire `%`. */
function endsWithComment(latex: string): boolean {
  return latexCommentStart(latex.slice(latex.lastIndexOf('\n') + 1)) !== -1
}

/**
 * Lignes réunies sur une seule ligne, sauf après un commentaire `%` (qui commenterait la suite) ;
 * un saut de ligne final suit un dernier commentaire.
 */
function joinLines(lines: readonly string[]): string {
  let out = ''
  lines.forEach((line, index) => {
    if (index > 0) out += endsWithComment(out) ? '\n' : ' '
    out += line
  })
  return endsWithComment(out) ? `${out}\n` : out
}

/**
 * Passe à la ligne après chaque `\\\\` de premier niveau (avec `*` et `[…]` éventuels), la ligne
 * suivante prenant `indent` : présentation d'un `align` réécrit par l'éditeur visuel, qui rend
 * tout sur une ligne. Les sauts de ligne déjà présents sont gardés.
 */
export function breakRows(latex: string, indent: string): string {
  let out = ''
  let depth = 0
  let i = 0
  while (i < latex.length) {
    const ch = latex.charAt(i)
    if (ch === '\\') {
      const rest = latex.slice(i)
      if (/^\\begin(?![a-zA-Z])/.test(rest)) depth++
      else if (/^\\end(?![a-zA-Z])/.test(rest)) depth--
      else if (latex[i + 1] === '\\' && depth === 0) {
        const row = /^\\\\\*?(?:\s*\[[^\]\n]*\])?/.exec(rest)?.[0] ?? '\\\\'
        out += row
        i += row.length
        const spaces = /^[ \t]*/.exec(latex.slice(i))?.[0] ?? ''
        i += spaces.length
        // Rien à couper en fin de texte, avant un saut de ligne ou un commentaire de fin de ligne.
        if (i < latex.length && latex[i] !== '\n' && latex[i] !== '%') out += `\n${indent}`
        else out += spaces
        continue
      }
      out += latex.slice(i, i + 2)
      i += 2
      continue
    }
    if (ch === '{') depth++
    else if (ch === '}') depth--
    out += ch
    i++
  }
  return out
}

/**
 * Texte d'une nouvelle formule : `\( … \)`, `\[ … \]` ou `equation` (avec `\label`). Une formule à
 * plusieurs lignes (`\\` au niveau supérieur) est placée dans `aligned` (en ligne, centrée) ou
 * `split` (numérotée, un seul numéro) pour rester valide.
 */
export function formatFormula({ body, style, label }: FormulaInput): string {
  const latex = body.trim()
  const multiline = hasTopLevel(latex, '\\\\')
  const lines = (multiline && style !== 'inline' ? breakRows(latex, '') : latex)
    .split('\n')
    .map((line) => line.trim())
  if (style === 'inline') {
    const inline = joinLines(lines)
    return multiline ? `\\(\\begin{aligned}${inline}\\end{aligned}\\)` : `\\(${inline}\\)`
  }
  const inner = multiline
    ? [
        `\\begin{${style === 'equation' ? 'split' : 'aligned'}}`,
        ...lines.map((line) => INDENT + line),
        `\\end{${style === 'equation' ? 'split' : 'aligned'}}`,
      ]
    : lines
  if (style === 'display') return ['\\[', ...inner.map((line) => INDENT + line), '\\]'].join('\n')
  const name = label?.trim() ?? ''
  return [
    '\\begin{equation}',
    ...(name === '' ? [] : [`${INDENT}\\label{${name}}`]),
    ...inner.map((line) => INDENT + line),
    '\\end{equation}',
  ].join('\n')
}

/**
 * Nouveau texte d'une formule existante. Même présentation : seuls la formule et le `\label` sont
 * remplacés, délimiteurs, environnement (`align`…) et espacement sont gardés (texte identique si
 * rien ne change). Autre présentation : la formule est réécrite par `formatFormula`.
 */
export function rewriteFormula(match: FormulaMatch, input: FormulaInput): string {
  if (input.style !== match.style) return formatFormula(input)
  const base = match.from
  const newLabel =
    input.style === 'equation' ? (input.label?.trim() ?? '') : (match.label?.name ?? '')
  // Formule terminée par un commentaire : la fin de ligne qui suit (délimiteur, label) doit exister.
  const tail = match.text.slice(
    match.bodyTo - base,
    (match.label && match.label.from >= match.bodyTo ? match.label.from : match.contentTo) - base,
  )
  const body = endsWithComment(input.body) && !tail.includes('\n') ? `${input.body}\n` : input.body
  const pieces: { from: number; to: number; insert: string }[] = [
    { from: match.bodyFrom - base, to: match.bodyTo - base, insert: body },
  ]
  if (match.label) {
    const { from, to } = match.label
    if (newLabel === '') {
      // Label retiré avec les blancs qui le séparent de la formule.
      const before = from < match.bodyFrom
      pieces.push(
        before
          ? { from: from - base, to: match.bodyFrom - base, insert: '' }
          : { from: match.bodyTo - base, to: to - base, insert: '' },
      )
    } else if (newLabel !== match.label.name) {
      pieces.push({ from: from - base, to: to - base, insert: `\\label{${newLabel}}` })
    }
  } else if (newLabel !== '') {
    // Nouveau label avant la formule, sur sa propre ligne si la formule commence une ligne.
    const lead = match.text.slice(match.contentFrom - base, match.bodyFrom - base)
    const separator = lead.includes('\n') ? lead.slice(lead.lastIndexOf('\n')) : ' '
    pieces.push({
      from: match.bodyFrom - base,
      to: match.bodyFrom - base,
      insert: `\\label{${newLabel}}${separator}`,
    })
  }
  pieces.sort((a, b) => b.from - a.from || b.to - a.to)
  let text = match.text
  for (const piece of pieces) text = text.slice(0, piece.from) + piece.insert + text.slice(piece.to)
  return text
}

/**
 * Valeur à charger dans MathLive pour une formule existante : les environnements à plusieurs
 * lignes (`align`, `gather`…) sont présentés dans `aligned` ou `gathered`, que MathLive sait éditer.
 */
export function mathfieldValue(match: FormulaMatch | null): {
  value: string
  wrapper?: 'aligned' | 'gathered'
} {
  if (match === null) return { value: '' }
  const wrapper = match.environment === undefined ? undefined : EDITOR_WRAPPERS[match.environment]
  if (
    wrapper === undefined ||
    (!hasTopLevel(match.body, '\\\\') && !hasTopLevel(match.body, '&'))
  ) {
    return { value: match.body }
  }
  return { value: `\\begin{${wrapper}}${match.body}\\end{${wrapper}}`, wrapper }
}

/** Retire l'environnement ajouté par `mathfieldValue` (si MathLive l'a conservé). */
export function fromMathfield(value: string, wrapper?: 'aligned' | 'gathered'): string {
  const latex = value.trim()
  if (wrapper === undefined) return latex
  const begin = `\\begin{${wrapper}}`
  const end = `\\end{${wrapper}}`
  if (!latex.startsWith(begin) || !latex.endsWith(end)) return latex
  const inner = latex.slice(begin.length, latex.length - end.length)
  // Refusé si l'environnement de tête ne couvre pas tout le texte (`\begin{aligned}…\end{aligned}x`).
  return balancedEnvironments(inner) ? inner.trim() : latex
}

function balancedEnvironments(latex: string): boolean {
  let depth = 0
  for (const match of latex.matchAll(/\\(begin|end)(?![a-zA-Z])/g)) {
    depth += match[1] === 'begin' ? 1 : -1
    if (depth < 0) return false
  }
  return depth === 0
}

/** Environnements où `&` sépare des colonnes (le reste du corps d'une formule les refuse). */
const ALIGNMENT_ENVIRONMENTS = new Set<string>(['align', 'align*', 'flalign', 'flalign*'])

/** Vrai si `&` est permis au niveau supérieur d'une formule écrite dans cet environnement. */
export function allowsAlignment(environment: string | undefined): boolean {
  return environment !== undefined && ALIGNMENT_ENVIRONMENTS.has(environment)
}

/** Délimiteurs de formule interdits à l'intérieur d'une formule. */
const NESTED_DELIMITERS: Readonly<Record<string, string>> = {
  '(': '\\(',
  ')': '\\)',
  '[': '\\[',
  ']': '\\]',
}

/**
 * Problèmes du corps d'une formule qui empêcheraient la compilation ou casseraient le texte qui
 * suit : accolades non équilibrées, `$` (sort du mode mathématique), `#`, `&` hors environnement
 * d'alignement, délimiteurs `\\( \\[` ou environnement mathématique imbriqués, `\\begin`/`\\end`
 * sans partenaire. `alignment` : la formule sera écrite dans `align`, `aligned` ou `split`
 * (`&` permis au niveau supérieur). Les commentaires `%` sont ignorés ; le contenu de `\\text{…}`
 * peut contenir une formule `$…$`.
 */
export function formulaIssues(body: string, options: { alignment?: boolean } = {}): string[] {
  const latex = stripLatexComments(body)
  const issues = new Set<string>()
  // Groupes ouverts : `true` pour un groupe texte (`\\text{`).
  const groups: boolean[] = []
  const envs: string[] = []
  for (let i = 0; i < latex.length; i++) {
    const ch = latex.charAt(i)
    const inText = groups.includes(true)
    if (ch === '\\') {
      const rest = latex.slice(i, i + 60)
      const text = TEXT_ARGUMENT.exec(rest)
      if (text !== null) {
        groups.push(true)
        i += text[0].length - 1
        continue
      }
      const env = /^\\(begin|end)\s*\{([^{}]*)\}/.exec(rest)
      if (env !== null) {
        const name = env[2]?.trim() ?? ''
        if (env[1] === 'begin') {
          if ((MATH_ENVIRONMENTS as readonly string[]).includes(name)) {
            issues.add(`environnement « ${name} » imbriqué dans une formule`)
          }
          envs.push(name)
        } else if (envs.at(-1) === name) envs.pop()
        else issues.add(`« \\end{${name}} » sans « \\begin{${name}} » correspondant`)
        i += env[0].length - 1
        continue
      }
      const next = latex.charAt(i + 1)
      const delimiter = NESTED_DELIMITERS[next]
      if (delimiter !== undefined && !inText) {
        issues.add(`délimiteur « ${delimiter} » dans une formule`)
      }
      i++
    } else if (ch === '{') groups.push(false)
    else if (ch === '}') {
      if (groups.length === 0) issues.add('accolade fermante en trop')
      else groups.pop()
    } else if (ch === '$' && !inText) issues.add('« $ » dans une formule (écrire \\$)')
    else if (ch === '#') issues.add('« # » ne compile pas (écrire \\#)')
    else if (ch === '&' && groups.length === 0 && envs.length === 0 && options.alignment !== true) {
      issues.add('« & » hors d’un environnement d’alignement (écrire \\& ou utiliser aligned)')
    }
  }
  if (groups.length > 0) issues.add('accolade non fermée')
  if (envs.length > 0) issues.add(`environnement « ${envs.at(-1) ?? ''} » non fermé`)
  return [...issues]
}

/**
 * Label sûr : lettres ASCII, chiffres et `: . _ / + -` (`#`, `&`, `$`, `%`, accolades et blancs ne
 * compilent pas ou cassent les références).
 */
export function sanitizeLabel(label: string): string {
  return label.replace(/[^A-Za-z0-9:._/+-]/g, '')
}
