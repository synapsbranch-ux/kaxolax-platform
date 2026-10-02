import type { EditorState } from '@codemirror/state'
import type { EditorView } from '@codemirror/view'
import { insertFromTool, type InsertStatus } from '../writing/apply.js'
import {
  allowsAlignment,
  breakRows,
  formatFormula,
  formulaIssues,
  type FormulaMatch,
  type FormulaStyle,
  formulaAt,
  fromMathfield,
  hasTopLevel,
  mathfieldValue,
  mathModeAt,
  rewriteFormula,
  TEXT_ARGUMENT,
} from '../writing/formula.js'
import { mathPackages } from '../writing/math-packages.js'
import { hasLatexComment, normalizeMathLive, stripLatexComments } from '../writing/mathlive.js'
import {
  captionIssue,
  floatForbiddenAt,
  generateTable,
  type TableParseResult,
  tableAt,
  tableCellIssues,
} from '../writing/table-latex.js'
import { type TableModel, tablesEqual } from '../writing/table-model.js'
import { type TextTarget, trackTarget } from '../writing/track.js'
import { canEdit, type ActionContext, type EditorAction } from './registry.js'

/** Identifiants des boîtes de dialogue des outils d'écriture (`host.openDialog(id, payload)`). */
export const WRITING_DIALOGS = {
  formula: 'math.formula',
  symbols: 'math.symbols',
  table: 'structures.table',
} as const

/** Contexte transmis à l'éditeur de formules. */
export interface FormulaDialogPayload {
  kind: 'formula'
  /** Formule sous le curseur (remplacée à l'insertion) ; null : nouvelle formule. */
  formula: FormulaMatch | null
  /** Plage remplacée à l'insertion : formule ou texte sélectionné ; null : insertion au curseur. */
  target: TextTarget | null
  /** Valeur initiale de MathLive (formule existante ou texte sélectionné). */
  initial: string
  /** Environnement ajouté autour d'un `align`… pour MathLive, retiré à l'insertion. */
  wrapper?: 'aligned' | 'gathered'
  style: FormulaStyle
  label: string
}

/** Contexte transmis au sélecteur de symboles. */
export interface SymbolsDialogPayload {
  kind: 'symbols'
  /** Le curseur est en mode mathématique (contenu d'une formule, hors `\\text{…}`). */
  math: boolean
}

/** Contexte transmis au générateur de tableaux. */
export interface TableDialogPayload {
  kind: 'table'
  /** Tableau sous le curseur (flottant ou tabular seul) ; null : nouveau tableau. */
  target: TextTarget | null
  scope?: 'float' | 'tabular'
  /**
   * Tableau seul déjà dans un flottant, une minipage ou une boîte, ou nouveau tableau inséré à
   * un tel endroit : pas de flottant `table` à ajouter.
   */
  nested?: boolean
  /** Grille analysée, ou texte brut si le tableau n'est pas représentable. */
  parse: TableParseResult | null
  /** Texte sélectionné hors tableau, à proposer comme collage (CSV, tabulations). */
  selection: string
}

export type WritingDialogPayload = FormulaDialogPayload | SymbolsDialogPayload | TableDialogPayload

/** Contexte de l'éditeur de formules pour la sélection principale. */
export function formulaDialogPayload(state: EditorState): FormulaDialogPayload {
  const { from, to, empty } = state.selection.main
  const formula = formulaAt(state.doc, from, to)
  if (formula) {
    const { value, wrapper } = mathfieldValue(formula)
    return {
      kind: 'formula',
      formula,
      target: { from: formula.from, to: formula.to, text: formula.text },
      initial: value,
      ...(wrapper === undefined ? {} : { wrapper }),
      style: formula.style,
      label: formula.label?.name ?? '',
    }
  }
  const line = state.doc.lineAt(from)
  const selection = state.sliceDoc(from, to)
  return {
    kind: 'formula',
    formula: null,
    target: empty ? null : { from, to, text: selection },
    initial: selection.trim(),
    // Ligne vide : formule centrée ; au milieu d'un paragraphe : en ligne.
    style: empty && line.text.trim() === '' ? 'display' : 'inline',
    label: '',
  }
}

/** Blancs d'un morceau en mode mathématique : retirés, sauf après une commande en lettres. */
function compactMath(latex: string): string {
  return latex
    .replace(/(\\[a-zA-Z]+)?\s+/g, (_all, command?: string) =>
      command === undefined ? '' : `${command} `,
    )
    .replace(/(\\[a-zA-Z]+) (?![a-zA-Z])/g, '$1')
}

/**
 * Forme de comparaison d'une formule : sans commentaires, blancs du mode mathématique retirés
 * (sauf ceux qui séparent une commande en lettres d'une lettre : `\\alpha x`), blancs des groupes
 * texte (`\\text{a b}`) réduits à une espace mais gardés.
 */
export function compactLatex(input: string): string {
  const latex = stripLatexComments(input)
  let out = ''
  let start = 0
  for (let i = 0; i < latex.length; i++) {
    if (latex[i] !== '\\') continue
    const open = TEXT_ARGUMENT.exec(latex.slice(i, i + 40))
    if (open === null) {
      i++
      continue
    }
    // Groupe texte : copié tel quel (blancs réduits), accolades équilibrées.
    let depth = 0
    let end = i + open[0].length - 1
    for (; end < latex.length; end++) {
      const ch = latex[end]
      if (ch === '\\') end++
      else if (ch === '{') depth++
      else if (ch === '}' && --depth === 0) break
    }
    out += compactMath(latex.slice(start, i))
    out += latex.slice(i, end + 1).replace(/\s+/g, ' ')
    start = end + 1
    i = end
  }
  return out + compactMath(latex.slice(start))
}

/** Valeur validée dans l'éditeur de formules. */
export interface FormulaResult {
  /** LaTeX lu dans MathLive (normalisé ici). */
  latex: string
  style: FormulaStyle
  label?: string
}

/** Formule à insérer : texte, packages, avertissements et erreurs (insertion refusée). */
export interface FormulaInsertion {
  text: string
  packages: string[]
  warnings: string[]
  /** Problèmes qui empêcheraient la compilation (accolades, `$`, `&`…) : insertion refusée. */
  errors: string[]
}

/** Texte et packages de la formule à insérer. */
export function formulaInsertion(
  payload: FormulaDialogPayload,
  result: FormulaResult,
): FormulaInsertion {
  const normalized = normalizeMathLive(result.latex)
  let body = fromMathfield(normalized.latex, payload.wrapper)
  const warnings: string[] = []
  const { formula } = payload
  // Formule inchangée (aux blancs près, que MathLive réécrit, et sans les commentaires, qu'il
  // retire) : le texte d'origine est gardé.
  const initial = normalizeMathLive(payload.initial).latex
  const sameBody =
    formula !== null &&
    (initial === normalized.latex ||
      (!hasLatexComment(normalized.latex) &&
        compactLatex(initial) === compactLatex(normalized.latex)))
  if (formula !== null && !sameBody) {
    if (hasLatexComment(formula.body) && !hasLatexComment(body)) {
      warnings.push('Les commentaires % de la formule seront retirés (éditeur visuel).')
    }
    // Formule à plusieurs lignes rendue sur une ligne par MathLive : une ligne par `\\`, avec
    // l'indentation d'origine.
    const indent = /\n([ \t]*)\S/.exec(formula.body)?.[1]
    if (indent !== undefined && !body.includes('\n') && result.style === formula.style) {
      body = breakRows(body, indent)
    }
  }
  const input = { body, style: result.style, label: result.label ?? '' }
  const keepLayout = formula !== null && formula.style === result.style
  const text =
    formula === null
      ? formatFormula(input)
      : rewriteFormula(formula, sameBody ? { ...input, body: formula.body } : input)
  // Équation numérotée passée en ligne ou centrée : son label disparaît avec ses références.
  if (formula?.label !== undefined && result.style !== 'equation') {
    const name = formula.label.name
    warnings.push(
      `Le label « ${name} » sera supprimé : les \\ref{${name}} et \\eqref{${name}} afficheront « ?? ».`,
    )
  }
  // Corps inchangé dans la même présentation : le texte d'origine est gardé, rien à vérifier.
  const errors =
    sameBody && keepLayout
      ? []
      : [
          ...normalized.warnings.map(
            (command) => `La commande ${command} de l’éditeur visuel n’existe pas en LaTeX.`,
          ),
          ...formulaIssues(body, {
            // `&` permis dans `align` gardé, ou dans `aligned`/`split` ajouté pour un texte à
            // plusieurs lignes (`formatFormula`).
            alignment: keepLayout
              ? allowsAlignment(formula.environment)
              : hasTopLevel(body.trim(), '\\\\'),
          }),
        ]
  const packages = [...new Set([...mathPackages(text), ...normalized.packages])]
  return { text, packages, warnings, errors }
}

/**
 * Insère la formule validée : remplacement exact de la formule ou de la sélection d'origine (même
 * présentation : délimiteurs et `\label` gardés), sinon insertion au curseur ; packages ajoutés.
 */
export function applyFormula(
  view: EditorView,
  payload: FormulaDialogPayload,
  result: FormulaResult,
): InsertStatus {
  const { text, packages, errors } = formulaInsertion(payload, result)
  if (errors.length > 0) return 'invalid'
  if (payload.target !== null && text === payload.target.text) return 'unchanged'
  const keepLayout = payload.formula !== null && payload.formula.style === result.style
  return insertFromTool(view, payload.target, text, {
    block: !keepLayout && result.style !== 'inline',
    packages,
  })
}

/** Contexte du générateur de tableaux pour la sélection principale. */
export function tableDialogPayload(state: EditorState): TableDialogPayload {
  const { from, to } = state.selection.main
  const match = tableAt(state.doc, from, to)
  if (match) {
    return {
      kind: 'table',
      target: { from: match.from, to: match.to, text: match.text },
      scope: match.scope,
      nested: match.nested,
      parse: match.result,
      selection: '',
    }
  }
  return {
    kind: 'table',
    target: null,
    // Curseur dans une figure, une minipage, un flottant… : pas de `table` imbriqué.
    nested: floatForbiddenAt(state.doc, from),
    parse: null,
    selection: state.sliceDoc(from, to),
  }
}

/** Vrai si le tableau à insérer ne peut pas recevoir de flottant `table` (voir `nested`). */
export function tableFloatLocked(payload: TableDialogPayload): boolean {
  return payload.nested === true && (payload.target === null || payload.scope === 'tabular')
}

/**
 * Insère le tableau validé (grille, ou texte brut pour un tableau non représentable) : remplacement
 * exact du tableau d'origine, sinon insertion en bloc au curseur ; packages ajoutés.
 */
export function applyTable(
  view: EditorView,
  payload: TableDialogPayload,
  table: TableModel | { raw: string },
): InsertStatus {
  if ('raw' in table) {
    if (payload.target !== null && table.raw === payload.target.text) return 'unchanged'
    return insertFromTool(view, payload.target, table.raw, { block: payload.target === null })
  }
  if (
    payload.target !== null &&
    payload.parse?.ok === true &&
    tablesEqual(payload.parse.model, table)
  ) {
    return 'unchanged'
  }
  // Tableau seul déjà dans un flottant ou une boîte : pas de second flottant (ne compilerait pas).
  const model =
    tableFloatLocked(payload) && table.float !== null ? { ...table, float: null } : table
  if (tableCellIssues(model).length > 0 || captionIssue(model) !== null) return 'invalid'
  const { text, packages } = generateTable(model)
  return insertFromTool(view, payload.target, text, { block: true, packages })
}

/** Outil disponible : éditeur modifiable et boîte de dialogue fournie par l'application. */
function canOpen(context: ActionContext): context is ActionContext & { view: EditorView } {
  return canEdit(context) && context.host.openDialog !== undefined
}

/** Actions des outils d'écriture (tâche 9) : elles ouvrent les boîtes de dialogue de l'application. */
export const writingActions: readonly EditorAction[] = [
  {
    id: WRITING_DIALOGS.formula,
    label: 'Éditeur de formules',
    menu: 'math',
    group: 'tools',
    icon: 'square-function',
    shortcut: 'Mod-Shift-e',
    when: canOpen,
    run: (context) => {
      if (!canOpen(context)) return false
      const payload = formulaDialogPayload(context.view.state)
      // Plage suivie pendant que la boîte est ouverte (modifications des collaborateurs).
      payload.target = trackTarget(context.view, payload.target)
      context.host.openDialog?.(WRITING_DIALOGS.formula, payload)
      return true
    },
  },
  {
    id: WRITING_DIALOGS.symbols,
    label: 'Symboles',
    menu: 'math',
    group: 'tools',
    icon: 'omega',
    when: canOpen,
    run: (context) => {
      if (!canOpen(context)) return false
      const { state } = context.view
      const { from, to } = state.selection.main
      const payload: SymbolsDialogPayload = {
        kind: 'symbols',
        math: mathModeAt(state.doc, from, to),
      }
      context.host.openDialog?.(WRITING_DIALOGS.symbols, payload)
      return true
    },
  },
  {
    id: WRITING_DIALOGS.table,
    label: 'Tableau',
    menu: 'structures',
    group: 'floats',
    icon: 'table',
    when: canOpen,
    run: (context) => {
      if (!canOpen(context)) return false
      const payload = tableDialogPayload(context.view.state)
      payload.target = trackTarget(context.view, payload.target)
      context.host.openDialog?.(WRITING_DIALOGS.table, payload)
      return true
    },
  },
]
