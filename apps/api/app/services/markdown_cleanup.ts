import {
  AI_CREDIT_MICROS,
  LATEX_SENSITIVE_COMMANDS,
  latexCode,
  MAX_TEXT_DOCUMENT_BYTES,
} from '@kaxolax/contracts'
import type User from '#models/user'
import type ClaudeService from '#services/claude/claude_service'
import { OPERATION_SETTINGS } from '#services/claude/operations'

/**
 * Nettoyage par l'IA du LaTeX produit par pandoc (opération `markdown_cleanup`, profondeur
 * `low`) : Claude rend un texte plus proche d'un LaTeX écrit à la main, sans toucher au contenu.
 * Le Markdown n'est pas fiable (texte collé, fichier venu d'ailleurs) : une injection de prompt
 * peut faire écrire n'importe quoi au modèle. Sa sortie n'est donc jamais écrite telle quelle :
 * elle est validée ici par liste blanche (structure, mêmes images, aucune séquence de contrôle ni
 * aucun environnement absents de la sortie de pandoc, hors des quelques commandes de mise en forme
 * que la consigne autorise), puis montrée dans l'aperçu où l'utilisateur la garde ou revient à la
 * sortie de pandoc. La compilation reste de toute façon confinée par le sandbox.
 */

/** Prompt système figé (mis en cache) : ni date ni identifiant. */
export const CLEANUP_SYSTEM_PROMPT = `You clean up LaTeX that pandoc generated from Markdown, so that it reads like LaTeX written by hand. The user message gives the mode and the LaTeX between <latex> tags.

Rules:
- Keep every word, number, formula, footnote, label, link, citation and image path exactly as they are. Never translate, summarise, reorder or add content.
- Remove pandoc artefacts that are not needed: \\tightlist, \\def\\labelenumi{...}, \\noalign{}, the "{\\def\\LTcaptype{none} ... }" wrapper of uncaptioned tables, empty optional arguments such as \\begin{longtable}[], \\label{...} that nothing references when they only repeat a heading.
- Simplify markup when the result is equivalent: short tables may become tabular with booktabs rules, \\pandocbounded{\\includegraphics[keepaspectratio]{x}} may become \\includegraphics[width=\\linewidth,keepaspectratio]{x}.
- Keep the same environments balanced. Never add a command or an environment that is not already in the input, except \\toprule, \\midrule, \\bottomrule, \\cmidrule, \\hline, \\centering, \\linewidth, \\textwidth and the tabular, table and center environments. Never add an image.
- Mode "fragment": output the body only, never \\documentclass, a preamble or \\begin{document}. Mode "document": output the complete document, preamble included.
- Answer with the LaTeX only: no Markdown fence, no explanation.`

/** Commandes que le nettoyage peut introduire : tableaux booktabs, largeur des images. */
const CLEANUP_NEW_COMMANDS: ReadonlySet<string> = new Set([
  'toprule',
  'midrule',
  'bottomrule',
  'cmidrule',
  'hline',
  'centering',
  'linewidth',
  'textwidth',
  'includegraphics',
])
/** Environnements que le nettoyage peut introduire (tableaux courts). */
const CLEANUP_NEW_ENVIRONMENTS: ReadonlySet<string> = new Set(['tabular', 'table', 'center'])

/**
 * Noms des séquences de contrôle (`\nom`, lettres et `@` : `\@@input` donne `@@input`) du texte
 * entier, commentaires et verbatim compris : lu dans l'ordre de TeX, `\\input` est un saut de
 * ligne suivi du mot « input ».
 */
function controlSequenceList(text: string): string[] {
  const names: string[] = []
  for (const match of text.matchAll(/\\(?:([A-Za-z@]+)|[^A-Za-z@])/g)) {
    if (match[1] !== undefined) names.push(match[1])
  }
  return names
}

const controlSequences = (text: string) => new Set(controlSequenceList(text))

function commandCount(text: string, name: string): number {
  return controlSequenceList(text).filter((found) => found === name).length
}

function environmentNames(text: string): Set<string> {
  return new Set(
    [...text.matchAll(/\\(?:begin|end)\s*\{([^}]*)\}/g)].map((match) => (match[1] ?? '').trim()),
  )
}

/** Notation `^^5c` de TeX (un caractère par son code, `\` compris). */
const caretCount = (text: string) => text.split('^^').length - 1

/** Environnements ouverts et fermés : chaque nom a autant de `\begin` que de `\end`. */
function environmentsBalanced(code: string): boolean {
  const counts = new Map<string, number>()
  for (const match of code.matchAll(/\\(begin|end)\s*\{([^}]+)\}/g)) {
    const name = match[2] ?? ''
    counts.set(name, (counts.get(name) ?? 0) + (match[1] === 'begin' ? 1 : -1))
  }
  return [...counts.values()].every((count) => count === 0)
}

function graphicsPaths(code: string): Set<string> {
  return new Set(
    [...code.matchAll(/\\includegraphics\s*(?:\[[^\]]*\])?\s*\{([^}]*)\}/g)].map(
      (match) => match[1] ?? '',
    ),
  )
}

/** Retire une clôture Markdown (```latex … ```) que le modèle aurait ajoutée malgré la consigne. */
export function unfence(text: string): string {
  const fenced = /^\s*```[a-zA-Z]*\n([\s\S]*?)\n```\s*$/.exec(text)
  return (fenced?.[1] ?? text).trim()
}

/**
 * Vérifie un LaTeX à écrire (sortie de pandoc ou du nettoyage, texte validé dans l'aperçu) :
 * fragment sans préambule, document complet sinon, environnements équilibrés, taille d'un
 * document ; le contenu des verbatim n'est pas de la structure (voir `latexCode`). Avec
 * `original` (sortie de pandoc), liste blanche : exactement les mêmes images, aucune séquence de
 * contrôle (`\csname`, `\@@input`, `\lstinputlisting`…) ni aucun environnement (`filecontents`…)
 * absents de l'original hors `CLEANUP_NEW_*` (cherchés dans tout le texte, commentaires et
 * verbatim compris : un `\fvset{commandchars=…}` rend un `Verbatim` actif), aucune notation `^^`
 * ni commande sensible de plus. Renvoie la raison du refus, ou null.
 */
export function latexProblem(
  latex: string,
  mode: 'fragment' | 'document',
  original: string | null = null,
): string | null {
  if (latex.trim() === '') return 'the text is empty'
  if (Buffer.byteLength(latex, 'utf8') >= MAX_TEXT_DOCUMENT_BYTES) return 'the text is too large'
  const code = latexCode(latex)
  const complete = /\\documentclass(?![A-Za-z@])/.test(code) && /\\begin\s*\{document\}/.test(code)
  const preamble = /\\documentclass(?![A-Za-z@])|\\begin\s*\{document\}|\\end\s*\{document\}/
  if (mode === 'fragment' && preamble.test(code)) return 'a fragment has no preamble'
  if (mode === 'document' && !complete) return 'a complete document is expected'
  if (!environmentsBalanced(code)) return 'environments are not balanced'
  if (original === null) return null
  const before = latexCode(original)
  const knownCommands = controlSequences(original)
  for (const name of controlSequences(latex)) {
    if (!knownCommands.has(name) && !CLEANUP_NEW_COMMANDS.has(name)) return `\\${name} was added`
  }
  const knownEnvironments = environmentNames(original)
  for (const name of environmentNames(latex)) {
    if (!knownEnvironments.has(name) && !CLEANUP_NEW_ENVIRONMENTS.has(name)) {
      return `the environment ${name} was added`
    }
  }
  const images = graphicsPaths(code)
  const imagesBefore = graphicsPaths(before)
  for (const path of imagesBefore) {
    if (!images.has(path)) return `the image ${path} is missing`
  }
  for (const path of images) {
    if (!imagesBefore.has(path)) return `the image ${path} was added`
  }
  if (caretCount(latex) > caretCount(original)) return '^^ notation was added'
  for (const name of LATEX_SENSITIVE_COMMANDS) {
    if (
      commandCount(code, name) > commandCount(before, name) ||
      commandCount(latex, name) > commandCount(original, name)
    ) {
      return `\\${name} was added`
    }
  }
  return null
}

export interface CleanupOutcome {
  latex: string
  applied: boolean
  warning: string | null
  credits: number
}

/** Plafond de sortie : de quoi réécrire le texte (environ 3 octets par token), dans celui de l'opération. */
function outputBudget(latex: string): number {
  const estimate = Math.ceil(Buffer.byteLength(latex, 'utf8') / 3) + 2_048
  return Math.min(OPERATION_SETTINGS.markdown_cleanup.maxTokens, Math.max(4_096, estimate))
}

/**
 * Appelle Claude (droits, IA activée, limite de débit et crédits vérifiés par le service) et
 * valide sa sortie ; une sortie coupée ou non conforme est écartée avec un avertissement (le
 * coût reste décompté). Les erreurs de l'IA (désactivée, crédits épuisés, indisponible) passent.
 */
export async function cleanupLatex(
  claude: ClaudeService,
  user: User,
  project: { id: string },
  latex: string,
  mode: 'fragment' | 'document',
): Promise<CleanupOutcome> {
  const result = await claude.run({
    user,
    project,
    operation: 'markdown_cleanup',
    effort: 'low',
    system: CLEANUP_SYSTEM_PROMPT,
    messages: [
      {
        role: 'user',
        content: `Mode: ${mode}\n\n<latex>\n${latex}\n</latex>`,
      },
    ],
    maxTokens: outputBudget(latex),
    acceptTruncated: true,
  })
  const credits = Math.round((result.costMicros / AI_CREDIT_MICROS) * 100) / 100
  if (result.truncated) {
    return {
      latex,
      applied: false,
      warning: 'The AI answer was cut off: the pandoc output is kept',
      credits,
    }
  }
  const cleaned = unfence(result.text)
  const problem = latexProblem(cleaned, mode, latex)
  if (problem !== null) {
    return {
      latex,
      applied: false,
      warning: `The AI answer was discarded (${problem}): the pandoc output is kept`,
      credits,
    }
  }
  return { latex: `${cleaned}\n`, applied: true, warning: null, credits }
}
