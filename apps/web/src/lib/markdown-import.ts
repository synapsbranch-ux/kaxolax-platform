import { ChangeSet } from '@codemirror/state'
import {
  definesName,
  type MarkdownImportResponse,
  preambleCode,
  type PreambleDefinition,
  type RequiredLatexPackage,
} from '@kaxolax/contracts'
import { findPreamble, planPackage } from '@kaxolax/editor'
import { localizedErrorMessage } from './api'

/** Messages français des erreurs de `POST /projects/:id/convert/markdown`. */
export const MARKDOWN_IMPORT_ERRORS: Readonly<Record<string, string>> = {
  E_CONVERT_FAILED: 'La conversion a échoué.',
  E_CONVERT_REJECTED: 'Le compilateur a refusé cette conversion (nom du fichier ou options).',
  E_CONVERT_BUSY: 'Une conversion est déjà en cours : réessayez dans un instant.',
  E_NOT_MARKDOWN: 'Seuls les fichiers .md et .markdown peuvent être convertis.',
  E_MARKDOWN_TOO_LARGE: 'Ce Markdown est trop long pour être converti.',
  E_INVALID_LATEX: 'Le LaTeX à écrire n’est pas valide.',
  E_SOURCE_CHANGED: 'Le Markdown a changé depuis l’aperçu : relancez l’aperçu.',
  E_NAME_TAKEN: 'Un fichier porte déjà ce nom : choisissez-en un autre.',
  E_PLAN_LIMIT: 'La limite du plan est atteinte (stockage ou crédits IA).',
  E_COMPILE_UNAVAILABLE: 'Le compilateur est indisponible : réessayez dans un instant.',
  E_TOO_MANY_COMPILERS: 'Trop de compilateurs actifs : réessayez dans quelques minutes.',
  E_AI_DISABLED: 'L’IA est désactivée pour ce projet.',
  E_AI_UNAVAILABLE: 'L’IA n’est pas disponible pour le moment.',
  E_AI_RATE_LIMITED: 'Trop de demandes à l’IA : réessayez dans un instant.',
  E_AI_OVERLOADED: 'L’IA est surchargée : réessayez dans un instant.',
  E_AI_REFUSED: 'L’IA a refusé de nettoyer ce texte.',
  E_VALIDATION_ERROR: 'Requête invalide (nom de fichier ou options).',
}

/**
 * Message d'une erreur de conversion. Pour `E_CONVERT_FAILED`, la cause donnée par l'API (délai,
 * mémoire, erreur de pandoc) est ajoutée, en anglais comme pandoc.
 */
export function markdownImportErrorMessage(error: unknown): string {
  const base = localizedErrorMessage(error, MARKDOWN_IMPORT_ERRORS)
  if (
    error instanceof Error &&
    'code' in error &&
    error.code === 'E_CONVERT_FAILED' &&
    error.message !== '' &&
    error.message !== 'The Markdown conversion failed'
  ) {
    return `${base} ${error.message}`
  }
  return base
}

/**
 * Texte collé à remplacer par la conversion : seulement par la conversion de ce même texte
 * (onglet « Coller », aucun fichier de l'ordinateur chargé, Markdown inchangé) et dans le document
 * où il a été collé. Sinon (fichier du projet ou de l'ordinateur, Markdown retouché, autre
 * document ouvert) : undefined, la conversion est insérée au curseur et le texte collé reste.
 */
export function pastedTextToReplace<T extends { text: string }>(
  replace: T | undefined,
  state: {
    source: 'paste' | 'project'
    localFile: boolean
    markdown: string
    activeDocumentId: string | null
    originDocumentId: string | null
  },
): T | undefined {
  if (replace === undefined || state.source !== 'paste' || state.localFile) return undefined
  if (state.markdown !== replace.text) return undefined
  if (state.activeDocumentId === null || state.activeDocumentId !== state.originDocumentId) {
    return undefined
  }
  return replace
}

/** Fichier `.tex` proposé : la source `.md` avec l'extension `.tex`, sinon `imported.tex`. */
export function defaultTargetPath(sourcePath: string | null): string {
  return sourcePath === null
    ? 'imported.tex'
    : sourcePath.replace(/\.(?:md|markdown)$/i, '') + '.tex'
}

/** Chemin à donner à `\input` depuis le document principal : relatif, sans `.tex`. */
export function includePath(mainPath: string, targetPath: string): string {
  const from = mainPath.split('/').slice(0, -1)
  const to = targetPath.replace(/\.tex$/i, '').split('/')
  let common = 0
  while (common < from.length && common < to.length - 1 && from[common] === to[common]) common++
  return [...from.slice(common).map(() => '..'), ...to.slice(common)].join('/')
}

/** Insertion de texte, relative au texte obtenu après les insertions précédentes. */
export interface TextInsertion {
  from: number
  insert: string
}

/**
 * `\input{path}` avant `\end{document}` du document principal ; null s'il l'inclut déjà
 * (`\input` ou `\include`) ou s'il n'a pas de `\end{document}`.
 */
export function planInclude(text: string, path: string): TextInsertion | null {
  const escaped = path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  if (new RegExp(`\\\\(?:input|include)\\s*\\{${escaped}(?:\\.tex)?\\}`).test(text)) return null
  const end = /^[ \t]*\\end\s*\{document\}/m.exec(text)
  if (end === null) return null
  return { from: end.index, insert: `\\input{${path}}\n` }
}

/** Commentaire qui précède les définitions ajoutées au préambule. */
export const DEFINITIONS_COMMENT =
  '% Définitions utilisées par le LaTeX importé du Markdown (pandoc)'

export interface PreambleMerge {
  /** Insertions successives à appliquer dans l'ordre. */
  changes: TextInsertion[]
  /** Packages ajoutés, ou dont des options ont été ajoutées. */
  added: string[]
  /** Chargés dans une liste sans les options demandées : à régler à la main. */
  conflicts: string[]
  /** Définitions ajoutées. */
  definitions: string[]
  /** Le document n'a pas de préambule : rien n'a été planifié. */
  noPreamble: boolean
}

/**
 * Ajouts au préambule du document principal, recalculés sur son texte courant : packages par
 * `planPackage` (aucun doublon, ordre de chargement respecté, hyperref en dernier) puis
 * définitions absentes juste avant `\begin{document}`.
 */
export function planPreambleMerge(
  text: string,
  packages: readonly RequiredLatexPackage[],
  definitions: readonly PreambleDefinition[],
): PreambleMerge {
  const merge: PreambleMerge = {
    changes: [],
    added: [],
    conflicts: [],
    definitions: [],
    noPreamble: false,
  }
  if (findPreamble(text) === null) return { ...merge, noPreamble: true }
  let current = text
  const apply = (change: TextInsertion) => {
    merge.changes.push(change)
    current = current.slice(0, change.from) + change.insert + current.slice(change.from)
  }
  for (const entry of packages) {
    const plan = planPackage(current, entry.name, entry.options)
    if (plan.status === 'insert' || plan.status === 'update') {
      apply(plan.change)
      merge.added.push(entry.name)
    } else if (plan.status === 'conflict') {
      merge.conflicts.push(entry.name)
    }
  }
  const preamble = preambleCode(current) ?? ''
  const missing = definitions.filter((entry) => !definesName(preamble, entry.name))
  if (missing.length > 0) {
    const end = findPreamble(current)?.end ?? current.length
    const lineStart = current.lastIndexOf('\n', end - 1) + 1
    const header = current.includes(DEFINITIONS_COMMENT) ? '' : `${DEFINITIONS_COMMENT}\n`
    apply({
      from: lineStart,
      insert: `${header}${missing.map((entry) => entry.code).join('\n')}\n`,
    })
    merge.definitions = missing.map((entry) => entry.name)
  }
  return merge
}

/** Résumé en français des ajouts au préambule (message après l'import). */
export function preambleMergeMessage(merge: PreambleMerge, mainPath: string): string {
  if (merge.noPreamble) {
    return `${mainPath} n’a pas de préambule : ajoutez-y les packages nécessaires.`
  }
  const parts: string[] = []
  if (merge.added.length > 0) parts.push(`packages ajoutés : ${merge.added.join(', ')}`)
  if (merge.definitions.length > 0) {
    parts.push(
      `${String(merge.definitions.length)} définition${merge.definitions.length > 1 ? 's' : ''}`,
    )
  }
  if (merge.conflicts.length > 0) {
    parts.push(`options à vérifier : ${merge.conflicts.join(', ')}`)
  }
  return parts.length === 0
    ? `Le préambule de ${mainPath} avait déjà tout le nécessaire.`
    : `Préambule de ${mainPath} complété (${parts.join(' ; ')}).`
}

/** Le résultat a quelque chose à ajouter au préambule du document principal. */
export function needsPreamble(result: MarkdownImportResponse): boolean {
  return (
    result.preamble.mode === 'main' &&
    (result.preamble.missingPackages.length > 0 || result.preamble.missingDefinitions.length > 0)
  )
}

/** Fichier Markdown (extension). */
export function isMarkdownPath(path: string): boolean {
  return /\.(?:md|markdown)$/i.test(path)
}

/**
 * Insertions successives réunies en une seule modification CodeMirror (une transaction, une
 * étape d'annulation) sur un document de `length` caractères.
 */
export function composeInsertions(length: number, changes: readonly TextInsertion[]): ChangeSet {
  let set = ChangeSet.empty(length)
  for (const change of changes) set = set.compose(ChangeSet.of(change, set.newLength))
  return set
}

/**
 * Plage où insérer le fragment converti : le texte collé, à sa place ou, s'il a été déplacé par
 * des modifications (locales ou d'un collaborateur), à l'occurrence la plus proche de sa place ;
 * sinon (texte modifié ou supprimé, autre document : `replace` absent) la sélection principale.
 */
export function insertionRange(
  text: string,
  selection: { from: number; to: number },
  replace: { text: string; from: number; to: number } | undefined,
): { from: number; to: number; replaced: boolean } {
  if (replace === undefined || replace.text === '') return { ...selection, replaced: false }
  let best = -1
  for (
    let index = text.indexOf(replace.text);
    index !== -1;
    index = text.indexOf(replace.text, index + 1)
  ) {
    if (best === -1 || Math.abs(index - replace.from) < Math.abs(best - replace.from)) best = index
    if (index >= replace.from) break
  }
  if (best === -1) return { ...selection, replaced: false }
  return { from: best, to: best + replace.text.length, replaced: true }
}
