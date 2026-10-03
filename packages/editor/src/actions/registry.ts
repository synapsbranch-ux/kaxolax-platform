import { Compartment, type Extension, Prec } from '@codemirror/state'
import { type EditorView, type KeyBinding, keymap, ViewPlugin } from '@codemirror/view'
import type { MarkdownPaste } from './markdown.js'

/** Menus de la barre d'outils (bouton Tools), dans l'ordre d'affichage. */
export const ACTION_MENUS = [
  { id: 'file', label: 'Fichier' },
  { id: 'format', label: 'Format' },
  { id: 'structures', label: 'Structures' },
  { id: 'math', label: 'Maths' },
  { id: 'graphics', label: 'Graphiques' },
  { id: 'packages', label: 'Packages' },
  { id: 'search', label: 'Rechercher' },
  { id: 'replace', label: 'Remplacer' },
] as const

export type ActionMenu = (typeof ACTION_MENUS)[number]['id']

/** Demande de saisie d'un texte à l'interface (nom d'environnement, de package…). */
export interface PromptRequest {
  title: string
  label: string
  defaultValue?: string
  placeholder?: string
}

/**
 * Fonctions fournies par l'application aux actions. Toutes sont facultatives : une action dont le
 * callback manque est désactivée. Les outils à boîte de dialogue (éditeur de formules, symboles,
 * tableaux, gestionnaire de packages…) passent par `openDialog`.
 */
export interface ActionHost {
  /** Droits de l'utilisateur en lecture seule (viewer, reviewer), même sans fichier ouvert. */
  readOnly?: boolean
  compile?: () => void
  newFile?: () => void
  newFolder?: () => void
  upload?: () => void
  downloadZip?: () => void
  /** Recherche dans tout le projet, préremplie avec le texte sélectionné. */
  searchProject?: (query: string) => void
  /**
   * Ouvre une boîte de dialogue de l'application. Outils d'écriture (`WRITING_DIALOGS`) :
   * `math.formula` reçoit un `FormulaDialogPayload`, `math.symbols` un `SymbolsDialogPayload`,
   * `structures.table` un `TableDialogPayload` (plage et contenu détectés sous le curseur) ; la
   * boîte de dialogue insère ensuite avec `applyFormula`, `insertSymbol` ou `applyTable` sur
   * l'éditeur courant. Sans ce callback, ces outils sont désactivés.
   */
  openDialog?: (dialog: string, payload?: unknown) => void
  /** Demande un texte à l'utilisateur ; null si annulé. */
  prompt?: (request: PromptRequest) => Promise<string | null>
  /** Message court (toast). */
  notify?: (message: string, level?: 'info' | 'warning' | 'error') => void
  /**
   * Collage intelligent : du Markdown évident vient d'être collé (texte et plage dans le
   * document) ; l'application propose de le convertir en LaTeX. Absent : aucune détection.
   */
  onMarkdownPaste?: (paste: MarkdownPaste) => void
}

/** Contexte d'exécution d'une action : éditeur courant (null sans fichier texte ouvert) et application. */
export interface ActionContext {
  view: EditorView | null
  host: ActionHost
}

export interface EditorAction {
  /** Identifiant unique, préfixé par le menu (`format.bold`). */
  id: string
  /** Libellé en français. */
  label: string
  menu: ActionMenu
  /** Groupe dans le menu (séparateurs, sous-menus) ; les groupes gardent leur ordre d'apparition. */
  group?: string
  /** Nom d'icône lucide (`bold`, `sigma`…), résolu par l'application. */
  icon?: string
  /** Raccourci en notation CodeMirror (`Mod-b`, `Mod-Alt-f`). */
  shortcut?: string
  /** Disponibilité selon le contexte (lecture seule, éditeur ouvert…) ; toujours disponible sinon. */
  when?: (context: ActionContext) => boolean
  /** Exécute l'action ; `false` : rien n'a été fait (la touche passe alors aux autres raccourcis). */
  run: (context: ActionContext) => boolean | undefined | Promise<unknown>
}

/** Vrai si l'utilisateur ne peut pas modifier (droits ou éditeur en lecture seule). */
export function isReadOnly(context: ActionContext): boolean {
  return context.host.readOnly === true || (context.view?.state.readOnly ?? false)
}

/** Un éditeur est ouvert. */
export function hasEditor(context: ActionContext): context is ActionContext & { view: EditorView } {
  return context.view !== null
}

/** Un éditeur est ouvert et modifiable. */
export function canEdit(context: ActionContext): context is ActionContext & { view: EditorView } {
  return hasEditor(context) && !isReadOnly(context)
}

export interface ActionRegistry {
  /** Ajoute des actions ; renvoie la fonction qui les retire. Un identifiant déjà pris est refusé. */
  register: (actions: EditorAction | readonly EditorAction[]) => () => void
  get: (id: string) => EditorAction | undefined
  /** Toutes les actions, dans l'ordre d'enregistrement. */
  all: () => EditorAction[]
  /** Actions d'un menu, regroupées par `group` (ordre de première apparition du groupe). */
  byMenu: (menu: ActionMenu) => EditorAction[]
  /** L'action existe et son prédicat `when` l'autorise. */
  isEnabled: (id: string, context: ActionContext) => boolean
  /** Exécute une action ; false si elle est absente, désactivée ou sans effet. */
  run: (id: string, context: ActionContext) => boolean
  /**
   * Extension CodeMirror qui lie les raccourcis des actions, prioritaire sur les raccourcis par
   * défaut, et suit les actions enregistrées ou retirées ensuite.
   */
  keymap: (host: ActionHost | (() => ActionHost)) => Extension
  /** Prévient à chaque ajout ou retrait (pour redessiner la barre d'outils). */
  subscribe: (listener: () => void) => () => void
}

/** Registre d'actions vide (voir `createDefaultRegistry` pour les actions de base). */
export function createActionRegistry(initial: readonly EditorAction[] = []): ActionRegistry {
  const actions = new Map<string, EditorAction>()
  const listeners = new Set<() => void>()
  const notify = () => {
    for (const listener of [...listeners]) listener()
  }

  const isEnabled = (id: string, context: ActionContext) => {
    const action = actions.get(id)
    return action !== undefined && (action.when?.(context) ?? true)
  }

  const run = (id: string, context: ActionContext) => {
    const action = actions.get(id)
    if (action === undefined || !(action.when?.(context) ?? true)) return false
    const result = action.run(context)
    if (result instanceof Promise) {
      // Erreur d'une action asynchrone : signalée à l'interface plutôt que perdue.
      result.catch((error: unknown) => {
        context.host.notify?.(error instanceof Error ? error.message : String(error), 'error')
      })
      return true
    }
    return result !== false
  }

  const bindings = (getHost: () => ActionHost): KeyBinding[] =>
    [...actions.values()].flatMap((action) =>
      action.shortcut === undefined
        ? []
        : [
            {
              // Sans preventDefault : une action désactivée laisse la touche aux autres raccourcis.
              key: action.shortcut,
              run: (view: EditorView) => run(action.id, { view, host: getHost() }),
            },
          ],
    )

  const registry: ActionRegistry = {
    register(input) {
      const list: readonly EditorAction[] = Array.isArray(input) ? input : [input as EditorAction]
      for (const action of list) {
        if (actions.has(action.id)) throw new Error(`Action already registered: ${action.id}`)
      }
      for (const action of list) actions.set(action.id, action)
      notify()
      return () => {
        let changed = false
        for (const action of list) {
          // Ne retire que l'action enregistrée par cet appel (pas un remplaçant de même id).
          if (actions.get(action.id) === action) {
            actions.delete(action.id)
            changed = true
          }
        }
        if (changed) notify()
      }
    },
    get: (id) => actions.get(id),
    all: () => [...actions.values()],
    byMenu(menu) {
      const groups = new Map<string, EditorAction[]>()
      for (const action of actions.values()) {
        if (action.menu !== menu) continue
        const key = action.group ?? ''
        const group = groups.get(key)
        if (group) group.push(action)
        else groups.set(key, [action])
      }
      return [...groups.values()].flat()
    },
    isEnabled,
    run,
    keymap(host) {
      const getHost = typeof host === 'function' ? host : () => host
      const compartment = new Compartment()
      const follower = ViewPlugin.define((view) => {
        let destroyed = false
        const unsubscribe = registry.subscribe(() => {
          // Hors du cycle de mise à jour en cours : un enregistrement peut venir d'un rendu.
          queueMicrotask(() => {
            if (destroyed) return
            view.dispatch({ effects: compartment.reconfigure(keymap.of(bindings(getHost))) })
          })
        })
        return {
          destroy() {
            destroyed = true
            unsubscribe()
          },
        }
      })
      return [Prec.high(compartment.of(keymap.of(bindings(getHost)))), follower]
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
  if (initial.length > 0) registry.register(initial)
  return registry
}
