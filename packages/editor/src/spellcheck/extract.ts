import type { Text } from '@codemirror/state'
import { groupEnd } from '../scan.js'
import { maskCode } from '../writing/mask.js'

/** Mot à vérifier et sa position dans le document. */
export interface SpellWord {
  word: string
  from: number
  to: number
}

/**
 * Commandes dont les arguments ne sont pas du texte : nombre d'arguments obligatoires ignorés
 * (`Infinity` : tous les groupes qui suivent). Les arguments optionnels `[…]` sont toujours ignorés,
 * sauf pour `TEXT_OPTIONAL`.
 */
const SKIPPED_ARGUMENTS: Readonly<Record<string, number>> = {
  label: 1,
  ref: 1,
  eqref: 1,
  pageref: 1,
  autoref: 1,
  Autoref: 1,
  cref: 1,
  Cref: 1,
  cpageref: 1,
  labelcref: 1,
  crefrange: 2,
  Crefrange: 2,
  nameref: 1,
  vref: 1,
  Vref: 1,
  subref: 1,
  nocite: 1,
  bibitem: 1,
  usepackage: 1,
  RequirePackage: 1,
  documentclass: 1,
  input: 1,
  include: 1,
  includeonly: 1,
  subfile: 1,
  import: 2,
  includegraphics: 1,
  includesvg: 1,
  includepdf: 1,
  graphicspath: 1,
  bibliography: 1,
  bibliographystyle: 1,
  addbibresource: 1,
  url: 1,
  nolinkurl: 1,
  href: 1,
  hyperref: 0,
  hypersetup: 1,
  begin: 1,
  end: 1,
  newcommand: Infinity,
  renewcommand: Infinity,
  providecommand: Infinity,
  DeclareRobustCommand: Infinity,
  NewDocumentCommand: Infinity,
  RenewDocumentCommand: Infinity,
  DeclareMathOperator: Infinity,
  newenvironment: Infinity,
  renewenvironment: Infinity,
  NewDocumentEnvironment: Infinity,
  newtheorem: 1,
  theoremstyle: 1,
  newcounter: 1,
  setcounter: 2,
  addtocounter: 2,
  newlength: 1,
  setlength: 2,
  addtolength: 2,
  settowidth: 1,
  hspace: 1,
  vspace: 1,
  'hspace*': 1,
  'vspace*': 1,
  rule: 2,
  raisebox: 1,
  parbox: 1,
  makebox: 0,
  framebox: 0,
  scalebox: 1,
  resizebox: 2,
  rotatebox: 1,
  color: 1,
  textcolor: 1,
  colorbox: 1,
  fcolorbox: 2,
  pagecolor: 1,
  definecolor: Infinity,
  rowcolor: 1,
  cellcolor: 1,
  columncolor: 1,
  multicolumn: 2,
  multirow: 2,
  cmidrule: 1,
  cline: 1,
  pagestyle: 1,
  thispagestyle: 1,
  pagenumbering: 1,
  setcitestyle: 1,
  usetikzlibrary: 1,
  usepgfplotslibrary: 1,
  tikzset: 1,
  pgfplotsset: 1,
  tikz: Infinity,
  lstset: 1,
  lstinputlisting: 1,
  inputminted: 2,
  mintinline: 2,
  mint: 2,
  setminted: 1,
  geometry: 1,
  newgeometry: 1,
  captionsetup: 1,
  setlist: 1,
  sisetup: 1,
  SI: 2,
  si: 1,
  num: 1,
  qty: 2,
  unit: 1,
  ang: 1,
  numlist: 1,
  selectlanguage: 1,
  foreignlanguage: 1,
  fontsize: 2,
  usefont: 4,
  fontfamily: 1,
  setmainfont: 1,
  setsansfont: 1,
  setmonofont: 1,
  newfontfamily: 2,
  setmainlanguage: 1,
  setotherlanguage: 1,
  usetheme: 1,
  usecolortheme: 1,
  usefonttheme: 1,
  useinnertheme: 1,
  useoutertheme: 1,
  setbeamertemplate: Infinity,
  setbeamercolor: Infinity,
  setbeamerfont: Infinity,
  gls: 1,
  Gls: 1,
  glspl: 1,
  Glspl: 1,
  acrshort: 1,
  acrlong: 1,
  acrfull: 1,
  ac: 1,
  newglossaryentry: Infinity,
  newacronym: 1,
  crefname: 1,
  Crefname: 1,
  numberwithin: 2,
  counterwithin: 2,
  renewbibmacro: Infinity,
  DeclareFieldFormat: Infinity,
  ExecuteBibliographyOptions: Infinity,
  pgfmathsetmacro: Infinity,
  def: Infinity,
  let: 0,
  ifthenelse: 1,
  verb: 0,
  lstinline: 1,
  texttt: 1,
}

/** Commandes dont l'argument optionnel est du texte (titre court, légende courte, puce). */
const TEXT_OPTIONAL = new Set([
  'part',
  'chapter',
  'section',
  'subsection',
  'subsubsection',
  'paragraph',
  'subparagraph',
  'caption',
  'item',
  'footnote',
])

/** Commandes dont tous les arguments sont ignorés : un nom en `cite` (natbib, biblatex). */
const CITE = /cite/i

/** Environnements mathématiques : contenu ignoré. */
const MATH_ENVIRONMENTS = new Set([
  'math',
  'displaymath',
  'equation',
  'equation*',
  'align',
  'align*',
  'alignat',
  'alignat*',
  'flalign',
  'flalign*',
  'gather',
  'gather*',
  'multline',
  'multline*',
  'eqnarray',
  'eqnarray*',
  'dmath',
  'dmath*',
  'IEEEeqnarray',
  'IEEEeqnarray*',
])

/** Environnements dont le contenu n'est pas du texte (dessins, code, données). */
const NON_TEXT_ENVIRONMENTS = new Set([
  'tikzpicture',
  'pgfpicture',
  'circuitikz',
  'tikzcd',
  'forest',
  'axis',
  'picture',
  'filecontents',
  'filecontents*',
  'lstlisting',
  'minted',
  'verbatim',
  'verbatim*',
  'Verbatim',
  'comment',
  'algorithmic',
])

/** Arguments obligatoires après `\begin{nom}` qui ne sont pas du texte. */
const ENVIRONMENT_ARGUMENTS: Readonly<Record<string, number>> = {
  tabular: 1,
  'tabular*': 2,
  tabularx: 2,
  tabulary: 2,
  longtable: 1,
  array: 1,
  minipage: 1,
  multicols: 1,
  'multicols*': 1,
  wrapfigure: 2,
  wraptable: 2,
  subfigure: 1,
  subtable: 1,
  column: 1,
  thebibliography: 1,
  otherlanguage: 1,
  'otherlanguage*': 1,
  spacing: 1,
  adjustbox: 1,
  tcolorbox: 0,
}

/** Lettres d'un mot (avec les marques combinantes) et liaisons internes `'`, `’`, `-`. */
const WORD = /[\p{L}\p{M}]+(?:['’-][\p{L}\p{M}]+)*/gu
const LETTER = /[\p{L}\p{M}\p{N}_@]/u

function isLetter(code: number): boolean {
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || code === 64
}

/** Fin d'un groupe `{…}` ou `[…]` ; fin du texte s'il n'est pas fermé. */
function skipGroup(code: string, start: number): number {
  const end = groupEnd(code, start)
  return end < 0 ? code.length : end
}

function skipSpaces(code: string, index: number): number {
  let i = index
  while (i < code.length && (code[i] === ' ' || code[i] === '\t' || code[i] === '\n')) i++
  return i
}

/**
 * Saute les arguments d'une commande : optionnels toujours (sauf `textOptional`), puis `count`
 * groupes obligatoires. Renvoie la position qui suit, et le début d'un argument optionnel texte.
 */
function skipArguments(
  code: string,
  from: number,
  count: number,
  textOptional: boolean,
): { to: number; textRanges: [number, number][] } {
  const textRanges: [number, number][] = []
  let i = from
  let skipped = 0
  for (;;) {
    const next = skipSpaces(code, i)
    const char = code[next]
    if (char === '[') {
      const end = skipGroup(code, next)
      if (textOptional) textRanges.push([next + 1, end - 1])
      i = end
    } else if (char === '{' && skipped < count) {
      i = skipGroup(code, next)
      skipped++
    } else if (char === '<' && count === Infinity) {
      // Spécification d'overlay de beamer `<2->`.
      const close = code.indexOf('>', next)
      i = close === -1 ? code.length : close + 1
    } else return { to: i, textRanges }
  }
}

/** Fin de `\end{name}` (fin du texte s'il manque). */
function environmentEnd(code: string, from: number, name: string): number {
  const pattern = new RegExp(`\\\\end\\s*\\{${name.replace(/[*]/g, '\\*')}\\}`, 'g')
  pattern.lastIndex = from
  const match = pattern.exec(code)
  return match ? match.index + match[0].length : code.length
}

/** Fin d'une formule ouverte par `open` à `from` (fin du texte si elle n'est pas fermée). */
function mathEnd(code: string, from: number, close: string): number {
  for (let i = from; i < code.length; i++) {
    const char = code[i]
    if (char === '\\') {
      if (close.startsWith('\\') && code.startsWith(close, i)) return i + close.length
      i++
    } else if (code.startsWith(close, i) && !close.startsWith('\\')) {
      return i + close.length
    }
  }
  return code.length
}

/**
 * Plages de texte à vérifier d'un document LaTeX : tout sauf les commandes et leurs arguments non
 * textuels (`\label`, `\ref`, `\cite`, `\usepackage`, `\begin{…}`, chemins, couleurs, longueurs),
 * les formules (`$…$`, `$$…$$`, `\(…\)`, `\[…\]`, environnements mathématiques), les commentaires
 * et le verbatim (`\verb`, `verbatim`, `lstlisting`, `minted`…), les dessins (`tikzpicture`).
 * Renvoie aussi le code masqué (commentaires et verbatim en espaces, positions identiques).
 */
export function textRanges(doc: Text | string): { code: string; ranges: [number, number][] } {
  const { code } = maskCode(doc)
  const ranges: [number, number][] = []
  let start = 0
  const flush = (end: number) => {
    if (end > start) ranges.push([start, end])
  }
  let i = 0
  while (i < code.length) {
    const char = code[i]
    if (char === '$') {
      flush(i)
      const display = code[i + 1] === '$'
      i = mathEnd(code, i + (display ? 2 : 1), display ? '$$' : '$')
      start = i
      continue
    }
    if (char !== '\\') {
      i++
      continue
    }
    const next = code[i + 1]
    if (next === undefined) break
    if (next === '(' || next === '[') {
      flush(i)
      i = mathEnd(code, i + 2, next === '(' ? '\\)' : '\\]')
      start = i
      continue
    }
    if (!isLetter(next.charCodeAt(0))) {
      // Commande d'un caractère (`\%`, `\&`, `\\`, `\'`…) : coupe le mot qui l'entoure.
      flush(i)
      i += 2
      // `\\[2pt]` : espacement après un saut de ligne.
      if (next === '\\' && code[skipSpaces(code, i)] === '[') {
        i = skipGroup(code, skipSpaces(code, i))
      }
      start = i
      continue
    }
    flush(i)
    let end = i + 1
    while (end < code.length && isLetter(code.charCodeAt(end))) end++
    let name = code.slice(i + 1, end)
    if (code[end] === '*') {
      name += '*'
      end++
    }
    const bare = name.replace(/\*$/, '')
    if (bare === 'begin') {
      const open = skipSpaces(code, end)
      if (code[open] === '{') {
        const close = skipGroup(code, open)
        const environment = code.slice(open + 1, close - 1).trim()
        if (MATH_ENVIRONMENTS.has(environment) || NON_TEXT_ENVIRONMENTS.has(environment)) {
          i = environmentEnd(code, close, environment)
          start = i
          continue
        }
        const count = ENVIRONMENT_ARGUMENTS[environment] ?? 0
        i = skipArguments(code, close, count, false).to
        start = i
        continue
      }
    }
    const count = CITE.test(bare) ? Infinity : (SKIPPED_ARGUMENTS[name] ?? SKIPPED_ARGUMENTS[bare])
    if (count !== undefined) {
      const skipped = skipArguments(code, end, count, false)
      i = skipped.to
    } else if (TEXT_OPTIONAL.has(bare)) {
      // Argument optionnel texte (`\section[court]{long}`) : vérifié aussi.
      i = end
    } else {
      // Commande inconnue : un argument optionnel collé au nom n'est pas du texte (`\foo[x]`).
      i = code[end] === '[' ? skipGroup(code, end) : end
    }
    start = i
  }
  flush(code.length)
  return { code, ranges }
}

/** Vrai pour un sigle (`API`) ou un mot à majuscule interne (`LaTeX`, `iPhone`) : non vérifié. */
function isSpecialCase(word: string): boolean {
  const rest = word.slice(1)
  return rest !== rest.toLowerCase()
}

/** Accents et césure en commande d'un caractère (`\'e`, `hy\-phen`) : le mot est coupé. */
const ACCENT_COMMANDS = new Set(["'", '`', '^', '"', '~', '=', '.', '-'])

/** Le mot est collé à ce qui précède : chiffre, `_`, `@`, ou accent en commande. */
function gluedBefore(text: string, at: number): boolean {
  const before = text[at - 1]
  if (before === undefined) return false
  if (LETTER.test(before)) return true
  return ACCENT_COMMANDS.has(before) && text[at - 2] === '\\'
}

/** Le mot est collé à ce qui suit : chiffre, `_`, `@`, ou accent en commande. */
function gluedAfter(text: string, end: number): boolean {
  const after = text[end]
  if (after === undefined) return false
  if (LETTER.test(after)) return true
  return after === '\\' && ACCENT_COMMANDS.has(text[end + 1] ?? '')
}

/**
 * Mots à vérifier d'un document LaTeX (voir `textRanges`) : lettres Unicode avec apostrophes et
 * traits d'union internes. Sont ignorés les mots d'une lettre, les sigles et mots à majuscule
 * interne, et les mots collés à un chiffre, un `_`, un `@` ou à une commande (`caf\'e`).
 */
export function extractWords(doc: Text | string): SpellWord[] {
  // Code masqué : commentaires et verbatim y sont des espaces, aux mêmes positions.
  const { code: text, ranges } = textRanges(doc)
  const words: SpellWord[] = []
  for (const [from, to] of ranges) {
    const segment = text.slice(from, to)
    for (const match of segment.matchAll(WORD)) {
      const word = match[0]
      const at = from + match.index
      const end = at + word.length
      if (word.length < 2 || isSpecialCase(word)) continue
      if (gluedBefore(text, at) || gluedAfter(text, end)) continue
      words.push({ word, from: at, to: end })
    }
  }
  return words
}

/** Forme vérifiée d'un mot : apostrophe typographique remplacée par `'`. */
export function normalizeWord(word: string): string {
  return word.replace(/’/g, "'").normalize('NFC')
}
