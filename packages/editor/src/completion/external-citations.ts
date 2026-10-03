import type {
  Completion,
  CompletionContext,
  CompletionResult,
  CompletionSource,
} from '@codemirror/autocomplete'
import type { EditorView } from '@codemirror/view'
import { argumentContext } from './latex-completion.js'
import type { CompletionSources } from './project-index.js'

/** Référence d'une source externe (bibliothèque Zotero liée…) proposée après `\cite{`. */
export interface ExternalCitation {
  /** Clé insérée dans `\cite{…}`. */
  key: string
  /** Auteurs abrégés et année. */
  detail: string
  /** Titre. */
  title: string
  /** Identifiant de la référence dans sa source (élément Zotero). */
  id: string
}

/**
 * Source externe de citations fournie par l'application : recherche (annulable) et ajout de
 * l'entrée manquante au `.bib` du projet quand une référence est choisie.
 */
export interface CitationProvider {
  /** Nom de la source, affiché à côté de chaque proposition (« Zotero »). */
  readonly name: string
  search(query: string, signal: AbortSignal): Promise<readonly ExternalCitation[]>
  /**
   * Appelée après l'insertion de la clé : ajoute l'entrée au `.bib` (erreurs signalées par
   * l'application). Rend la clé finalement retenue : si elle diffère de celle insérée (clé prise
   * entre-temps par une autre référence), la clé insérée est remplacée. Null (ou promesse
   * rejetée) : l'ajout a échoué, la clé insérée est retirée et le texte saisi rétabli, pour ne
   * pas laisser une citation sans entrée.
   */
  pick(citation: ExternalCitation): Promise<string | null> | undefined
}

export interface ExternalCitationOptions {
  provider: () => CitationProvider | null
  /** Index du projet : les clés déjà présentes dans ses .bib ne sont pas reproposées. */
  sources?: () => CompletionSources | null
  /** Pause de frappe avant d'interroger la source (ms). */
  delayMs?: number
  /** Longueur minimale du texte cherché. */
  minLength?: number
}

/** Commande de citation (`\cite`, `\citep`, `\parencite`, `\nocite`…). */
export function isCiteCommand(command: string): boolean {
  return /cite/i.test(command)
}

function wait(ms: number, context: CompletionContext): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      resolve(!context.aborted)
    }, ms)
    context.addEventListener('abort', () => {
      clearTimeout(timer)
      resolve(false)
    })
  })
}

/**
 * Remplace la clé insérée à `from` par celle finalement retenue, si elle y est toujours (le texte
 * a pu changer entre-temps : rien n'est alors touché).
 */
export function correctInsertedKey(
  view: EditorView,
  from: number,
  inserted: string,
  actual: string,
): boolean {
  if (actual === inserted) return false
  const to = from + inserted.length
  if (to > view.state.doc.length || view.state.doc.sliceString(from, to) !== inserted) return false
  view.dispatch({ changes: { from, to, insert: actual }, userEvent: 'input.complete' })
  return true
}

/**
 * Source d'autocomplétion supplémentaire après `\cite{` : références trouvées par la source
 * externe pour le texte saisi (titre, auteur, année), hors clés déjà dans le projet. Choisir une
 * proposition insère la clé puis appelle `provider.pick` (ajout de l'entrée au `.bib`) ; si
 * l'ajout échoue, la clé est retirée (le texte saisi revient, s'il n'a pas été modifié). Les
 * propositions ne sont pas filtrées par CodeMirror : la source a déjà cherché (le texte saisi ne
 * ressemble pas forcément à la clé).
 */
export function externalCitationSource(options: ExternalCitationOptions): CompletionSource {
  const delayMs = options.delayMs ?? 250
  const minLength = options.minLength ?? 2
  return async (context: CompletionContext): Promise<CompletionResult | null> => {
    const provider = options.provider()
    if (provider === null) return null
    const argument = argumentContext(context.state, context.pos)
    if (!argument || !isCiteCommand(argument.command)) return null
    const query = argument.text.trim()
    if (query.length < minLength) return null
    if (!(await wait(delayMs, context))) return null
    const controller = new AbortController()
    context.addEventListener('abort', () => {
      controller.abort()
    })
    let citations: readonly ExternalCitation[]
    try {
      citations = await provider.search(query, controller.signal)
    } catch {
      return null
    }
    if (context.aborted) return null
    const known = new Set(
      options
        .sources?.()
        ?.citations()
        .map((citation) => citation.key) ?? [],
    )
    const completions: Completion[] = citations
      .filter((citation) => !known.has(citation.key))
      .map((citation) => ({
        label: citation.key,
        detail: [citation.detail, provider.name].filter((part) => part !== '').join(' · '),
        ...(citation.title === '' ? {} : { info: citation.title }),
        type: 'text',
        boost: -1,
        apply: (view: EditorView, _completion: Completion, from: number, to: number) => {
          const typed = view.state.sliceDoc(from, to)
          view.dispatch({
            changes: { from, to, insert: citation.key },
            selection: { anchor: from + citation.key.length },
            userEvent: 'input.complete',
          })
          // Échec de l'ajout : la clé insérée laisse place au texte saisi.
          const undo = () => {
            correctInsertedKey(view, from, citation.key, typed)
          }
          provider.pick(citation)?.then((actual) => {
            if (actual === null) undo()
            else correctInsertedKey(view, from, citation.key, actual)
          }, undo)
        },
      }))
    return completions.length === 0
      ? null
      : { from: argument.from, options: completions, filter: false }
  }
}

/**
 * Insère une citation au curseur : la clé est ajoutée à la liste si le curseur est déjà dans
 * l'argument d'une commande de citation (`\cite{a,|}` → `\cite{a,clé}`), sinon `\cite{clé}`
 * remplace la sélection. Faux si l'éditeur est en lecture seule.
 */
export function insertCitation(view: EditorView, key: string, command = 'cite'): boolean {
  const { state } = view
  if (state.readOnly) return false
  const selection = state.selection.main
  const argument = selection.empty ? argumentContext(state, selection.head) : null
  if (argument && isCiteCommand(argument.command)) {
    const before = state.sliceDoc(argument.from - 1, argument.from)
    const prefix = argument.text === '' && (before === '{' || before === ',') ? '' : ','
    const insert = argument.text === '' ? key : `${prefix}${key}`
    const at = argument.text === '' ? argument.from : selection.head
    view.dispatch({
      changes: { from: at, to: selection.head, insert },
      selection: { anchor: at + insert.length },
      userEvent: 'input',
      scrollIntoView: true,
    })
    return true
  }
  const insert = `\\${command}{${key}}`
  view.dispatch({
    changes: { from: selection.from, to: selection.to, insert },
    selection: { anchor: selection.from + insert.length },
    userEvent: 'input',
    scrollIntoView: true,
  })
  return true
}
