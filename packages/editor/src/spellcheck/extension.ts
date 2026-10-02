import {
  type EditorState,
  type Extension,
  Facet,
  StateEffect,
  StateField,
  type Text,
} from '@codemirror/state'
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
} from '@codemirror/view'
import type { SpellcheckClient } from './client.js'
import { extractWords, normalizeWord } from './extract.js'
import type { SpellLanguage } from './protocol.js'

/** Menu de suggestions d'un mot souligné, rendu par l'application (clic droit ou commande). */
export interface SpellcheckMenu {
  word: string
  from: number
  to: number
  /** Position du menu (coordonnées de la fenêtre). */
  x: number
  y: number
  /** Suggestions du dictionnaire (demandées au worker). */
  suggestions: () => Promise<string[]>
  /** Remplace le mot (une étape d'annulation). */
  replace: (text: string) => void
  /** Ajoute le mot au dictionnaire personnel (via `onAddToDictionary`). */
  addToDictionary: () => void
}

export interface SpellcheckConfig {
  client: SpellcheckClient
  /** Langue du projet (`projects.spellcheck_language`). */
  language: SpellLanguage
  /** Ouvre le menu de suggestions ; sans lui, le clic droit garde le menu du navigateur. */
  onMenu?: (menu: SpellcheckMenu) => void
  /** Ajout au dictionnaire personnel : l'application l'enregistre dans les préférences. */
  onAddToDictionary?: (word: string) => void
  /** Erreur du worker (dictionnaire indisponible…). */
  onError?: (error: unknown) => void
  /** Vérification aboutie (dictionnaire chargé) : l'application efface une erreur passée. */
  onChecked?: () => void
  /** Pause de frappe avant vérification, en millisecondes. */
  delayMs?: number
}

const misspelledMark = Decoration.mark({
  class: 'cm-spellError',
  attributes: { 'aria-invalid': 'spelling' },
})

const setMisspellings = StateEffect.define<DecorationSet>()

/** Configuration active du correcteur (null : désactivé). */
const spellcheckConfigFacet = Facet.define<SpellcheckConfig, SpellcheckConfig | null>({
  combine: (values) => values.at(-1) ?? null,
})

/** Configuration du correcteur actif dans l'éditeur (null : désactivé). */
export function spellcheckConfigOf(state: EditorState): SpellcheckConfig | null {
  return state.facet(spellcheckConfigFacet)
}

/** Soulignements en place : décalés avec les modifications, retirés des mots modifiés. */
const misspellings = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(decorations, transaction) {
    let next = decorations
    if (transaction.docChanged) {
      next = next.map(transaction.changes)
      transaction.changes.iterChangedRanges((_fromA, _toA, fromB, toB) => {
        next = next.update({
          filterFrom: fromB,
          filterTo: toB,
          filter: (from, to) => to < fromB || from > toB,
        })
      })
    }
    for (const effect of transaction.effects) if (effect.is(setMisspellings)) next = effect.value
    return next
  },
  provide: (field) => EditorView.decorations.from(field),
})

/** Mot souligné qui contient `pos`, s'il y en a un. */
export function misspellingAt(
  state: EditorState,
  pos: number,
): { from: number; to: number; word: string } | null {
  const decorations = state.field(misspellings, false)
  if (!decorations) return null
  const found: { from: number; to: number }[] = []
  decorations.between(pos, pos, (from, to) => {
    found.push({ from, to })
    return false
  })
  const first = found[0]
  if (!first) return null
  const { from, to } = first
  return { from, to, word: state.sliceDoc(from, to) }
}

/** Mots soulignés du document, dans l'ordre. */
export function misspelledRanges(state: EditorState): { from: number; to: number }[] {
  const ranges: { from: number; to: number }[] = []
  state.field(misspellings, false)?.between(0, state.doc.length, (from, to) => {
    ranges.push({ from, to })
  })
  return ranges
}

function buildDecorations(
  doc: Text,
  client: SpellcheckClient,
  language: SpellLanguage,
): DecorationSet {
  const ranges = extractWords(doc)
    .filter(({ word }) => client.known(language, normalizeWord(word)) === false)
    .map(({ from, to }) => misspelledMark.range(from, to))
  return Decoration.set(ranges, true)
}

function menuFor(
  view: EditorView,
  config: SpellcheckConfig,
  from: number,
  to: number,
  x: number,
  y: number,
): SpellcheckMenu {
  const word = view.state.sliceDoc(from, to)
  return {
    word,
    from,
    to,
    x,
    y,
    suggestions: () => config.client.suggest(config.language, normalizeWord(word)),
    replace: (text) => {
      // Le mot a pu bouger ou changer depuis l'ouverture du menu : rien n'est remplacé alors.
      if (view.state.sliceDoc(from, to) !== word) return
      view.dispatch({
        changes: { from, to, insert: text },
        selection: { anchor: from + text.length },
        userEvent: 'input.spellcheck',
      })
    },
    addToDictionary: () => config.onAddToDictionary?.(normalizeWord(word)),
  }
}

/**
 * Ouvre le menu de suggestions du mot souligné sous le curseur (raccourci ou menu de
 * l'application). Renvoie false s'il n'y a pas de mot souligné ou pas de menu.
 */
export function openSpellcheckMenu(view: EditorView): boolean {
  const config = view.state.facet(spellcheckConfigFacet)
  if (!config?.onMenu) return false
  const target = misspellingAt(view.state, view.state.selection.main.head)
  if (!target) return false
  const coords = view.coordsAtPos(target.from)
  config.onMenu(
    menuFor(view, config, target.from, target.to, coords?.left ?? 0, coords?.bottom ?? 0),
  )
  return true
}

/**
 * Correcteur orthographique : extrait les mots du texte LaTeX (commandes, maths, commentaires,
 * verbatim ignorés), les fait vérifier par le worker après une pause de frappe et souligne les
 * mots inconnus. Clic droit sur un mot souligné : menu de l'application (`onMenu`).
 */
export function spellcheck(config: SpellcheckConfig): Extension {
  const delay = config.delayMs ?? 400
  const plugin = ViewPlugin.fromClass(
    class {
      timer: ReturnType<typeof setTimeout> | null = null
      readonly unsubscribe: () => void
      destroyed = false

      constructor(readonly view: EditorView) {
        this.unsubscribe = config.client.subscribe(() => {
          this.schedule(0)
        })
        this.schedule(0)
      }

      update(update: ViewUpdate) {
        if (update.docChanged) this.schedule(delay)
      }

      schedule(ms: number) {
        if (this.timer !== null) clearTimeout(this.timer)
        this.timer = setTimeout(() => {
          this.timer = null
          void this.run()
        }, ms)
      }

      async run() {
        const doc = this.view.state.doc
        const words = extractWords(doc).map(({ word }) => normalizeWord(word))
        try {
          await config.client.check(config.language, words)
        } catch (error) {
          config.onError?.(error)
          return
        }
        config.onChecked?.()
        // Document modifié pendant la vérification : une autre passe est déjà programmée.
        if (this.destroyed || this.view.state.doc !== doc) return
        this.view.dispatch({
          effects: setMisspellings.of(buildDecorations(doc, config.client, config.language)),
        })
      }

      destroy() {
        this.destroyed = true
        if (this.timer !== null) clearTimeout(this.timer)
        this.unsubscribe()
      }
    },
  )
  return [
    spellcheckConfigFacet.of(config),
    misspellings,
    plugin,
    EditorView.domEventHandlers({
      contextmenu: (event, view) => {
        if (!config.onMenu) return false
        const pos = view.posAtCoords({ x: event.clientX, y: event.clientY })
        if (pos === null) return false
        const target = misspellingAt(view.state, pos)
        if (!target) return false
        event.preventDefault()
        config.onMenu(menuFor(view, config, target.from, target.to, event.clientX, event.clientY))
        return true
      },
    }),
  ]
}
