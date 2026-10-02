import { type Extension, StateEffect, StateField, Transaction } from '@codemirror/state'
import { type EditorView, ViewPlugin, type ViewUpdate } from '@codemirror/view'

/** Pause de frappe par défaut avant une compilation automatique. */
export const AUTO_COMPILE_DELAY_MS = 2_500

export interface AutoCompileOptions {
  /** Appelé après une pause de frappe. */
  onCompile: () => void
  /** Durée de la pause, en millisecondes. */
  delayMs?: number
  /**
   * Booléen : état initial, modifiable ensuite par `setAutoCompile`. Fonction : lue à chaque
   * modification et au déclenchement (préférence tenue par l'application).
   */
  enabled?: boolean | (() => boolean)
  /**
   * Transactions qui relancent l'attente. Par défaut `isLocalEdit` : les modifications avec un
   * événement utilisateur (frappe, collage, actions, historique de CodeMirror). Avec un
   * historique Yjs (`Y.UndoManager`), l'annulation arrive par y-codemirror sans événement
   * utilisateur, comme les modifications des collaborateurs : passer alors un filtre qui la
   * reconnaît (par exemple `undoManager.undoing || undoManager.redoing`).
   */
  filter?: (transaction: Transaction) => boolean
}

interface AutoCompileConfig {
  enabled: boolean
  delayMs: number
}

/** Change l'état de la compilation automatique (voir `setAutoCompile`). */
export const autoCompileEffect = StateEffect.define<Partial<AutoCompileConfig>>()

const autoCompileConfig = StateField.define<AutoCompileConfig>({
  create: () => ({ enabled: false, delayMs: AUTO_COMPILE_DELAY_MS }),
  update(value, transaction) {
    let next = value
    for (const effect of transaction.effects) {
      if (effect.is(autoCompileEffect)) next = { ...next, ...effect.value }
    }
    return next
  },
})

/** Modification locale : la transaction porte un événement utilisateur (`Transaction.userEvent`). */
export const isLocalEdit = (transaction: Transaction): boolean =>
  transaction.annotation(Transaction.userEvent) !== undefined

/**
 * Compilation automatique : appelle `onCompile` après `delayMs` sans modification locale.
 * Désactivable à tout moment (`setAutoCompile` ou fonction `enabled`) : l'attente en cours est
 * alors abandonnée. Une seule instance par éditeur.
 */
export function autoCompile(options: AutoCompileOptions): Extension {
  const filter = options.filter ?? isLocalEdit
  const allowed = () => (typeof options.enabled === 'function' ? options.enabled() : true)
  const initial: AutoCompileConfig = {
    enabled: typeof options.enabled === 'boolean' ? options.enabled : true,
    delayMs: options.delayMs ?? AUTO_COMPILE_DELAY_MS,
  }

  const plugin = ViewPlugin.fromClass(
    class {
      timer: ReturnType<typeof setTimeout> | null = null

      update(update: ViewUpdate) {
        const config = update.state.field(autoCompileConfig)
        if (!config.enabled || !allowed()) {
          this.cancel()
          return
        }
        if (!update.transactions.some((tr) => tr.docChanged && filter(tr))) return
        this.cancel()
        this.timer = setTimeout(() => {
          this.timer = null
          if (allowed()) options.onCompile()
        }, config.delayMs)
      }

      cancel() {
        if (this.timer === null) return
        clearTimeout(this.timer)
        this.timer = null
      }

      destroy() {
        this.cancel()
      }
    },
  )

  return [autoCompileConfig.init(() => initial), plugin]
}

/** Active, désactive ou change le délai de la compilation automatique d'un éditeur. */
export function setAutoCompile(view: EditorView, config: Partial<AutoCompileConfig>): void {
  view.dispatch({ effects: autoCompileEffect.of(config) })
}

/** État courant de la compilation automatique (null si l'extension est absente). */
export function autoCompileState(view: EditorView): AutoCompileConfig | null {
  return view.state.field(autoCompileConfig, false) ?? null
}
