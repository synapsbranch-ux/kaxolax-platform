import { Prec, type Extension } from '@codemirror/state'
import { EditorView } from '@codemirror/view'

/**
 * Présence des collaborateurs dans l'éditeur. Les curseurs et sélections distants sont dessinés
 * par y-codemirror.next (`yCollab`) à partir de l'awareness (`user.color`, `user.colorLight`,
 * `user.name`) ; ce module règle leur apparence et le suivi d'un collaborateur.
 */

/**
 * Apparence des curseurs distants : nom toujours affiché au-dessus du curseur (au lieu du seul
 * survol), texte de la couleur `--presence-foreground` de @kaxolax/ui (lisible sur les couleurs de
 * présence des deux thèmes), police de l'interface. Sélecteurs plus précis que le thème de base de
 * y-codemirror.next, qu'ils remplacent.
 */
export const collaboratorCursorTheme: Extension = EditorView.theme({
  '.cm-ySelectionCaret > .cm-ySelectionInfo': {
    opacity: '1',
    top: '-1.35em',
    borderRadius: '3px 3px 3px 0',
    padding: '0 4px',
    fontFamily: 'var(--font-sans, system-ui, sans-serif)',
    fontSize: '11px',
    lineHeight: '1.35em',
    color: 'var(--presence-foreground, #fff)',
    pointerEvents: 'none',
  },
  '.cm-ySelectionCaret': {
    borderLeftWidth: '2px',
  },
  // Le point masquait le début du nom, désormais toujours affiché.
  '.cm-ySelectionCaret > .cm-ySelectionCaretDot': {
    display: 'none',
  },
})

/** Touches seules qui ne comptent pas comme une frappe (modificateurs). */
const MODIFIER_KEYS = new Set(['Shift', 'Control', 'Alt', 'Meta', 'AltGraph', 'CapsLock'])

/** Vrai si l'événement clavier est une frappe de l'utilisateur (pas un modificateur seul). */
export function isUserKeystroke(event: Pick<KeyboardEvent, 'key'>): boolean {
  return !MODIFIER_KEYS.has(event.key)
}

/**
 * Appelle `onKeystroke` à chaque frappe dans l'éditeur (modificateurs seuls exclus), avant tout
 * autre traitement et sans l'empêcher : fin du suivi d'un collaborateur à la prochaine frappe.
 */
export function keystrokeListener(onKeystroke: () => void): Extension {
  // Priorité maximale : passé après les raccourcis (Entrée, Retour arrière…), qui consomment
  // l'événement, l'écouteur ne serait jamais appelé pour eux.
  return Prec.highest(
    EditorView.domEventHandlers({
      keydown: (event) => {
        if (isUserKeystroke(event)) onKeystroke()
        return false
      },
    }),
  )
}

/**
 * Fait défiler l'éditeur jusqu'à `position` (curseur d'un collaborateur suivi), sans changer la
 * sélection ni prendre le focus ; position bornée à la taille du document.
 */
export function revealPosition(view: EditorView, position: number): void {
  const at = Math.min(Math.max(0, position), view.state.doc.length)
  view.dispatch({ effects: EditorView.scrollIntoView(at, { y: 'nearest', yMargin: 80 }) })
}
