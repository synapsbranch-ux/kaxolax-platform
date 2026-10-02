/**
 * Normalisation du LaTeX produit par MathLive : ses commandes propres (`\exponentialE`,
 * `\differentialD`…) n'existent pas dans LaTeX. Chaque règle de `MATHLIVE_REPLACEMENTS` est testée ;
 * le résultat compile avec amsmath, plus les packages signalés (couleurs, `\cancel`…).
 */

/** Remplacement d'une commande MathLive (sans argument) par du LaTeX standard. */
export interface MathLiveReplacement {
  command: string
  latex: string
}

export const MATHLIVE_REPLACEMENTS: readonly MathLiveReplacement[] = [
  { command: '\\exponentialE', latex: 'e' },
  { command: '\\imaginaryI', latex: 'i' },
  { command: '\\imaginaryJ', latex: 'j' },
  { command: '\\differentialD', latex: '\\mathrm{d}' },
  { command: '\\capitalDifferentialD', latex: '\\mathrm{D}' },
  { command: '\\mleft', latex: '\\left' },
  { command: '\\mright', latex: '\\right' },
  { command: '\\lparen', latex: '(' },
  { command: '\\rparen', latex: ')' },
  { command: '\\lt', latex: '<' },
  { command: '\\gt', latex: '>' },
  { command: '\\coloneq', latex: '\\mathrel{:}=' },
  { command: '\\Colon', latex: '\\mathrel{::}' },
  { command: '\\N', latex: '\\mathbb{N}' },
  { command: '\\Z', latex: '\\mathbb{Z}' },
  { command: '\\Q', latex: '\\mathbb{Q}' },
  { command: '\\R', latex: '\\mathbb{R}' },
  { command: '\\C', latex: '\\mathbb{C}' },
  { command: '\\infin', latex: '\\infty' },
]

/**
 * Extensions HTML de MathLive (`\\htmlStyle{css}{x}`, `\\href{url}{x}`…) : sans équivalent LaTeX, et
 * dangereuses à l'affichage (CSS arbitraire, liens ouverts par un clic). Seul le contenu est gardé.
 */
const HTML_COMMANDS = [
  'href',
  'class',
  'htmlClass',
  'cssId',
  'htmlId',
  'htmlData',
  'htmlStyle',
  'style',
] as const

/** Commandes à argument retirées avec leur argument (cases vides, métadonnées d'affichage). */
const DROPPED = ['placeholder', ...HTML_COMMANDS.filter((name) => name !== 'href')] as const

export interface NormalizedFormula {
  latex: string
  /** Packages demandés par des commandes conservées (xcolor pour `\textcolor`…). */
  packages: string[]
  /** Commandes MathLive sans équivalent LaTeX (le texte ne compilerait pas). */
  warnings: string[]
}

/**
 * Commandes de MathLive sans équivalent LaTeX (`\\href` existe avec hyperref, `\\ensuremath` dans le
 * noyau) : une formule qui en contient est refusée à l'insertion.
 */
const UNSUPPORTED = ['\\unicode', '\\error']

const COLOR_COMMANDS = ['textcolor', 'color', 'colorbox', 'boxed']

function commandPattern(command: string): RegExp {
  return new RegExp(`${command.replace(/\\/g, '\\\\')}(?![a-zA-Z])`, 'g')
}

/** Fin du groupe `{…}` ou `[…]` qui commence à `start` (-1 sinon). */
function argumentEnd(text: string, start: number): number {
  const open = text[start]
  if (open !== '{' && open !== '[') return -1
  const close = open === '{' ? '}' : ']'
  let depth = 0
  for (let i = start; i < text.length; i++) {
    const ch = text[i]
    if (ch === '\\') i++
    else if (ch === open) depth++
    else if (ch === close && --depth === 0) return i + 1
  }
  return -1
}

/**
 * Retire `\placeholder[id]{…}` et les commandes d'affichage HTML (`\class{x}{y}` → `y`). Répété
 * jusqu'à ce que le texte ne change plus : retirer une commande peut en reformer une autre déjà
 * traitée (`\htmlSt\style yle{…}` → `\htmlStyle{…}`).
 */
function dropCommands(latex: string, names: readonly string[] = DROPPED): string {
  let out = latex
  // Chaque passage qui change le texte le raccourcit : la boucle se termine.
  for (let previous = ''; previous !== out;) {
    previous = out
    out = dropOnce(out, names)
  }
  return out
}

/** Un passage de `dropCommands` : chaque nom une fois, dans l'ordre. */
function dropOnce(latex: string, names: readonly string[]): string {
  let out = latex
  for (const name of names) {
    const pattern = new RegExp(`\\\\${name}(?![a-zA-Z])\\s*`, 'g')
    let match: RegExpExecArray | null
    while ((match = pattern.exec(out)) !== null) {
      let i = match.index + match[0].length
      if (out[i] === '[') i = Math.max(i, argumentEnd(out, i))
      const first = argumentEnd(out, i)
      if (first === -1) {
        // Sans argument entre accolades : la commande seule est retirée (rien n'est interprété).
        out = out.slice(0, match.index) + out.slice(match.index + match[0].length)
        pattern.lastIndex = match.index
        continue
      }
      // `\placeholder{x}` disparaît, `\class{nom}{x}` garde x.
      let replacement = ''
      let end = first
      if (name !== 'placeholder') {
        const second = argumentEnd(out, first)
        if (second !== -1) {
          replacement = out.slice(first + 1, second - 1)
          end = second
        }
      }
      out = out.slice(0, match.index) + replacement + out.slice(end)
      pattern.lastIndex = match.index
    }
  }
  return out
}

/**
 * Valeur sûre pour MathLive : le LaTeX d'un document partagé est affiché sans ses extensions HTML
 * (`\\href`, `\\htmlStyle`, `\\class`…), dont seul le contenu reste. À appliquer à toute valeur
 * chargée dans le champ (ouverture, texte brut, bibliothèque).
 */
export function sanitizeForMathLive(latex: string): string {
  return dropCommands(latex, HTML_COMMANDS)
}

/** Début du commentaire `%` d'une ligne (`\\%` n'en est pas un), -1 sinon. */
export function latexCommentStart(line: string): number {
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (ch === '\\') i++
    else if (ch === '%') return i
  }
  return -1
}

/** Vrai si le texte contient un commentaire `%`. */
export function hasLatexComment(latex: string): boolean {
  return latex.split('\n').some((line) => latexCommentStart(line) !== -1)
}

/** Texte sans ses commentaires `%` (le saut de ligne qui suit un commentaire devient une espace). */
export function stripLatexComments(latex: string): string {
  return latex
    .split('\n')
    .map((line) => {
      const at = latexCommentStart(line)
      return at === -1 ? line : line.slice(0, at)
    })
    .join(' ')
}

/** Marque d'un commentaire mis de côté pendant la normalisation. */
const COMMENT_MARK = /\uE000(\d+)\uE001/g

/** `\textcolor{#ff0000}{x}` → `\textcolor[HTML]{FF0000}{x}` (xcolor n'accepte pas `#`). */
function normalizeColors(latex: string): string {
  return latex.replace(
    /\\(textcolor|color|colorbox)\s*\{\s*#([0-9a-fA-F]{6}|[0-9a-fA-F]{3})\s*\}/g,
    (_all, command: string, hex: string) => {
      const full =
        hex.length === 3
          ? hex
              .split('')
              .map((digit) => digit + digit)
              .join('')
          : hex
      return `\\${command}[HTML]{${full.toUpperCase()}}`
    },
  )
}

/**
 * Normalise le LaTeX de MathLive : commandes propres remplacées (table `MATHLIVE_REPLACEMENTS`),
 * cases vides retirées, couleurs hexadécimales converties, blancs réduits à une espace (une espace
 * après une commande en lettres est gardée : `\alpha x`). Les sauts de ligne et l'indentation du
 * texte saisi sont gardés (lignes vides retirées : erreur en mode mathématique) ; les commentaires
 * `%` ne sont pas touchés et restent en fin de ligne, sans jamais commenter la suite.
 */
export function normalizeMathLive(input: string): NormalizedFormula {
  // Commentaires mis de côté (marques Unicode privées) : aucune règle ne touche leur texte.
  const comments: string[] = []
  const code = input
    .split(/\r?\n/)
    .map((line) => {
      const at = latexCommentStart(line)
      if (at === -1) return line
      comments.push(line.slice(at).trimEnd())
      return `${line.slice(0, at)}\uE000${String(comments.length - 1)}\uE001`
    })
    .join('\n')
  let latex = dropCommands(code)
  for (const { command, latex: replacement } of MATHLIVE_REPLACEMENTS) {
    latex = latex.replace(commandPattern(command), (_all, offset: number, whole: string) => {
      // Une lettre collée à une commande en lettres en formerait une autre : `\lt\imaginaryI` →
      // `\lt i`, `\R x` → `\mathbb{R} x`.
      const next = whole.charAt(offset + command.length)
      const before = /\\[a-zA-Z]+$/.test(whole.slice(0, offset)) && /^[a-zA-Z]/.test(replacement)
      const after = /^\\[a-zA-Z]+$/.test(replacement) && /[a-zA-Z]/.test(next)
      return `${before ? ' ' : ''}${replacement}${after ? ' ' : ''}`
    })
  }
  latex = normalizeColors(latex)
  latex = latex
    .split('\n')
    .map((line, index) => {
      const indent = index === 0 ? '' : (/^[ \t]*/.exec(line)?.[0] ?? '')
      return (
        indent +
        line
          .slice(indent.length)
          .replace(/[ \t]+/g, ' ')
          .trim()
      )
    })
    .filter((line) => line.trim() !== '')
    .join('\n')
    .trim()
  // Espace inutile entre une commande-symbole et un groupe ou un opérateur : `\frac {a}` → `\frac{a}`.
  latex = latex.replace(/(\\[a-zA-Z]+) (?=[{}^_[\]()])/g, '$1')

  const packages = new Set<string>()
  for (const command of COLOR_COMMANDS) {
    if (command !== 'boxed' && commandPattern(`\\${command}`).test(latex)) packages.add('xcolor')
  }
  if (/\\(b|x)?cancel(to)?(?![a-zA-Z])/.test(latex)) packages.add('cancel')
  const warnings = UNSUPPORTED.filter((command) => commandPattern(command).test(latex))
  latex = latex.replace(COMMENT_MARK, (_all, index: string) => comments[Number(index)] ?? '')
  return { latex, packages: [...packages], warnings }
}
