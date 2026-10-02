import { getIndentUnit, indentString } from '@codemirror/language'
import { EditorSelection, type EditorState, type Text } from '@codemirror/state'
import type { EditorView } from '@codemirror/view'
import { editCommand, type EditBuilder, type RequiredPackage } from '../actions/edit.js'
import { indentationOf } from '../scan.js'
import { mathModeAt } from './formula.js'
import { missingPackages } from './math-packages.js'
import type { LatexSymbol } from './symbols.js'
import { locateTarget, releaseTarget, type TextTarget } from './track.js'

/** Convertit les tabulations de tête (une par niveau) en indentation de l'éditeur. */
function expandIndent(state: EditorState, line: string): string {
  return line.replace(/^\t+/, (tabs) => indentString(state, tabs.length * getIndentUnit(state)))
}

export interface InsertOptions {
  /** Texte en bloc (lignes propres, indentation de la ligne courante) ou en ligne. */
  block: boolean
  /** Packages à charger dans le préambule s'ils manquent (même étape d'annulation). */
  packages?: readonly string[]
}

/**
 * Résultat d'une insertion depuis une boîte de dialogue ; `invalid` : le texte ne compilerait pas
 * (rien n'est fait).
 */
export type InsertStatus = 'replaced' | 'inserted' | 'unchanged' | 'stale' | 'read-only' | 'invalid'

/**
 * Packages à ajouter au préambule : ceux qui manquent, en tenant compte des packages qui en
 * chargent d'autres (`amssymb` charge `amsfonts`, `mathtools` charge `amsmath`). Fichier sans
 * préambule (inclus) : aucun.
 */
function packagesToAdd(state: EditorState, names: readonly string[]): RequiredPackage[] {
  return (missingPackages(state.doc, names) ?? []).map((name) => ({ name }))
}

/**
 * Construit la modification : remplace `target` (suivie par `locateTarget`) ou, sans cible, la
 * sélection principale. Un bloc commence une ligne, prend l'indentation de la ligne et repousse le
 * texte qui suit sur la ligne suivante ; ses lignes suivantes sont indentées de même.
 */
export function insertionBuilder(
  target: TextTarget | null,
  text: string,
  block: boolean,
): EditBuilder {
  return (state) => {
    const range = target === null ? state.selection.main : locateTarget(state, target)
    if (range === null) return null
    let { from, to } = range
    const startLine = state.doc.lineAt(from)
    const base = indentationOf(startLine.text)
    if (!block) {
      return {
        changes: { from, to, insert: text },
        selection: EditorSelection.cursor(from + text.length),
      }
    }
    const lines = text.split('\n').map((line) => expandIndent(state, line))
    const before = state.doc.sliceString(startLine.from, from)
    if (target !== null && before.trim() !== '') {
      // Plage au milieu d'une ligne (`\resizebox{…}{!}{\begin{tabular}…`) : remplacée sur place.
      const insert = lines.map((line, index) => (index === 0 ? line : base + line)).join('\n')
      return {
        changes: { from, to, insert },
        selection: EditorSelection.cursor(from + insert.length),
      }
    }
    const endLine = state.doc.lineAt(to)
    const after = state.doc.sliceString(to, endLine.to)
    const atLineStart = before.trim() === ''
    // En début de ligne, le bloc remplace l'indentation : la première ligne garde `base`.
    if (atLineStart) from = startLine.from
    const rest = after.trimStart()
    if (rest === '') to = endLine.to
    else to += after.length - rest.length
    const insert =
      (atLineStart ? '' : '\n') +
      lines.map((line) => base + line).join('\n') +
      (rest === '' ? '' : `\n${base}`)
    const end = from + insert.length - (rest === '' ? 0 : base.length + 1)
    return { changes: { from, to, insert }, selection: EditorSelection.cursor(end) }
  }
}

/**
 * Insère le texte produit par un outil (formule, tableau) : remplacement exact de la plage
 * détectée, ou insertion à la place de la sélection. Une seule étape d'annulation, packages
 * manquants ajoutés au préambule. `stale` : la plage a disparu entre-temps (rien n'est fait).
 */
export function insertFromTool(
  view: EditorView,
  target: TextTarget | null,
  text: string,
  options: InsertOptions,
): InsertStatus {
  if (view.state.readOnly) return 'read-only'
  if (target !== null && locateTarget(view.state, target) === null) return 'stale'
  const packages = packagesToAdd(view.state, options.packages ?? [])
  const done = editCommand(insertionBuilder(target, text, options.block), packages)(view)
  if (!done) return 'stale'
  releaseTarget(view, target)
  view.focus()
  return target === null ? 'inserted' : 'replaced'
}

/** Mot suivant collé à une commande en lettres (`\alpha` puis `x` → `\alpha x`). */
function separator(command: string, next: string, math: boolean): string {
  if (!/[a-zA-Z]$/.test(command) || !/^[a-zA-Z]/.test(next)) return ''
  return math ? ' ' : '{}'
}

/**
 * Texte d'un symbole à la position voulue : un symbole mathématique hors formule est placé dans
 * `\( \)`, un symbole texte dans une formule dans `\text{}` ; la sélection devient l'argument
 * d'un accent. Renvoie le texte et la position du curseur dans ce texte.
 */
export function symbolSnippet(
  symbol: LatexSymbol,
  options: { math: boolean; selection?: string; next?: string },
): { text: string; cursor: number } {
  const selection = options.selection ?? ''
  const wrapMath = symbol.mode === 'math' && !options.math
  const wrapText = symbol.mode === 'text' && options.math
  let core: string
  let cursor: number
  if (symbol.argument) {
    core = `${symbol.command}{${selection}}`
    cursor = selection === '' ? core.length - 1 : core.length
  } else {
    // Le texte qui suit (après la sélection remplacée) ne doit pas prolonger la commande :
    // `\alpha` puis `y` → `\alpha y`. Inutile dans `\( \)` ou `\text{}`, qui ferment le groupe.
    const glue =
      wrapMath || wrapText ? '' : separator(symbol.command, options.next ?? '', options.math)
    core = symbol.command + glue
    cursor = core.length
  }
  if (wrapMath) {
    return {
      text: `\\(${core}\\)`,
      cursor: cursor + 2 + (symbol.argument && selection === '' ? 0 : 2),
    }
  }
  if (wrapText) {
    return {
      text: `\\text{${core}}`,
      cursor: cursor + 6 + (symbol.argument && selection === '' ? 0 : 1),
    }
  }
  return { text: core, cursor }
}

/** Packages d'un symbole qui manquent au préambule du document principal (null : pas de préambule). */
export function symbolMissingPackages(
  preambleDoc: Text | string,
  symbol: LatexSymbol,
): string[] | null {
  return missingPackages(preambleDoc, symbol.packages)
}

/**
 * Insère un symbole à la place de chaque sélection (mode maths détecté à chaque position).
 * `addPackages` charge aussi ses packages manquants (et amsmath pour `\text`) dans le préambule
 * de ce document, dans la même étape d'annulation.
 */
export function insertSymbol(
  view: EditorView,
  symbol: LatexSymbol,
  options: { addPackages?: boolean } = {},
): boolean {
  if (view.state.readOnly) return false
  const build: EditBuilder = (state) =>
    state.changeByRange((range) => {
      const math = mathModeAt(state.doc, range.from, range.to)
      const snippet = symbolSnippet(symbol, {
        math,
        selection: state.sliceDoc(range.from, range.to),
        next: state.sliceDoc(range.to, range.to + 1),
      })
      return {
        changes: { from: range.from, to: range.to, insert: snippet.text },
        range: EditorSelection.cursor(range.from + snippet.cursor),
      }
    })
  // `\text` (amsmath) pour un symbole texte placé dans une formule.
  const needsText =
    symbol.mode === 'text' &&
    view.state.selection.ranges.some((range) => mathModeAt(view.state.doc, range.from, range.to))
  const packages =
    options.addPackages === true
      ? packagesToAdd(view.state, [...symbol.packages, ...(needsText ? ['amsmath'] : [])])
      : []
  const done = editCommand(build, packages)(view)
  if (done) view.focus()
  return done
}
