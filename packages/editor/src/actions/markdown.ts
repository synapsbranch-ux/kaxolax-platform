import type { Extension } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { type ActionContext, type ActionHost, type EditorAction, isReadOnly } from './registry.js'

/** Identifiant de la boîte de dialogue « Importer du Markdown » (`host.openDialog`). */
export const MARKDOWN_IMPORT_DIALOG = 'file.import-markdown'

/** Texte collé (ou sélectionné) dans un document : sa plage, pour le remplacer par la conversion. */
export interface MarkdownPaste {
  /** Texte Markdown, tel qu'il est dans le document. */
  text: string
  from: number
  to: number
  /**
   * Document où le texte a été collé (renseigné par l'application) : le remplacement n'a lieu que
   * dans ce document.
   */
  documentId?: string
}

/**
 * Contexte de la boîte « Importer du Markdown » : texte à convertir (collage, sélection), fichier
 * `.md` du projet, ou rien (l'utilisateur colle ou choisit un fichier dans la boîte).
 */
export interface MarkdownImportPayload {
  kind: 'markdown-import'
  markdown?: string
  documentId?: string
  /** Plage du document courant à remplacer par le fragment converti (texte collé). */
  replace?: MarkdownPaste
}

export function isMarkdownImportPayload(value: unknown): value is MarkdownImportPayload {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { kind?: unknown }).kind === 'markdown-import'
  )
}

/** Signes de Markdown, chacun compté une fois. */
const MARKDOWN_SIGNS: readonly { pattern: RegExp; weight: number }[] = [
  // Titres ATX (`## Titre`).
  { pattern: /^#{1,6}[ \t]+\S/m, weight: 1 },
  // Bloc de code clôturé.
  { pattern: /^(?:```|~~~)[\w-]*[ \t]*$/m, weight: 2 },
  // Tableau : ligne de séparation `|---|:---:|`.
  { pattern: /^\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)+\|?[ \t]*$/m, weight: 2 },
  // Listes à puces ou numérotées, sur deux lignes au moins.
  { pattern: /^[ \t]*[-*+][ \t]+\S.*\n[ \t]*[-*+][ \t]+\S/m, weight: 1 },
  { pattern: /^[ \t]*\d+[.)][ \t]+\S.*\n[ \t]*\d+[.)][ \t]+\S/m, weight: 1 },
  // Liens, images, gras, code en ligne, citation.
  { pattern: /!?\[[^\]\n]+\]\([^)\s]+(?:[ \t]+"[^"\n]*")?\)/, weight: 1 },
  { pattern: /(?:\*\*|__)\S(?:[^*\n]*\S)?(?:\*\*|__)/, weight: 1 },
  { pattern: /(?<![`\\])`[^`\n]+`(?!`)/, weight: 1 },
  { pattern: /^>[ \t]+\S/m, weight: 1 },
]

/**
 * Le texte est-il du Markdown évident (collage intelligent) ? Deux signes au moins (titre, liste,
 * lien, gras, code…), ou un bloc de code ou un tableau, et presque pas de LaTeX : un texte avec
 * `\begin{…}` ou plusieurs commandes est du LaTeX, jamais proposé à la conversion.
 */
export function looksLikeMarkdown(text: string): boolean {
  if (text.trim().length < 8) return false
  const commands = text.match(/\\[a-zA-Z]{2,}/g)?.length ?? 0
  if (/\\begin\s*\{/.test(text) || commands >= 3) return false
  let score = 0
  for (const sign of MARKDOWN_SIGNS) {
    if (sign.pattern.test(text)) score += sign.weight
  }
  return score >= 2
}

/** Payload de la boîte pour le contexte courant : la sélection si elle ressemble à du Markdown. */
export function markdownImportPayload(context: ActionContext): MarkdownImportPayload {
  const view = context.view
  if (view === null || isReadOnly(context)) return { kind: 'markdown-import' }
  const { from, to } = view.state.selection.main
  const text = view.state.sliceDoc(from, to)
  return from !== to && looksLikeMarkdown(text)
    ? { kind: 'markdown-import', markdown: text, replace: { text, from, to } }
    : { kind: 'markdown-import' }
}

/** Action de la barre Tools (menu Fichier) : ouvre « Importer du Markdown ». */
export const markdownImportAction: EditorAction = {
  id: MARKDOWN_IMPORT_DIALOG,
  label: 'Importer du Markdown…',
  menu: 'file',
  group: 'create',
  icon: 'file-down',
  when: (context) =>
    context.host.openDialog !== undefined &&
    context.host.readOnly !== true &&
    context.host.canEditProject !== false,
  run: (context) => {
    context.host.openDialog?.(MARKDOWN_IMPORT_DIALOG, markdownImportPayload(context))
    return true
  },
}

/**
 * Collage intelligent : après un collage (une seule plage) de Markdown évident dans un document
 * modifiable, prévient `host.onMarkdownPaste` avec le texte et sa plage. Le texte reste collé tel
 * quel : l'application propose la conversion, sans rien imposer.
 */
export function markdownPasteDetector(getHost: () => ActionHost): Extension {
  return EditorView.updateListener.of((update) => {
    if (!update.docChanged || update.state.readOnly) return
    const host = getHost()
    if (host.onMarkdownPaste === undefined || host.readOnly === true) return
    for (const transaction of update.transactions) {
      if (!transaction.isUserEvent('input.paste')) continue
      const inserted: MarkdownPaste[] = []
      transaction.changes.iterChanges((_fromA, _toA, fromB, toB, text) => {
        inserted.push({ text: text.toString(), from: fromB, to: toB })
      })
      const [paste] = inserted
      if (inserted.length !== 1 || paste === undefined || !looksLikeMarkdown(paste.text)) continue
      // Positions dans l'état final (modifications suivantes de la même mise à jour comprises).
      const later = update.transactions.slice(update.transactions.indexOf(transaction) + 1)
      let { from, to } = paste
      for (const next of later) {
        from = next.changes.mapPos(from, 1)
        to = next.changes.mapPos(to, -1)
      }
      host.onMarkdownPaste({ text: paste.text, from, to })
    }
  })
}
