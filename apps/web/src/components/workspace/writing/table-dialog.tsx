'use client'

import { EditorSelection } from '@codemirror/state'
import {
  applyTable,
  captionIssue,
  checkTable,
  cloneTable,
  createTable,
  deleteColumn,
  deleteRow,
  fixTableCells,
  generateTable,
  hasHorizontalRule,
  hasVerticalRule,
  insertColumn,
  insertRow,
  mergeCells,
  setAllVerticalRules,
  setColumnAlign,
  setHorizontalRule,
  sanitizeLabel,
  setTableRuleStyle,
  splitCell,
  type TableDialogPayload,
  tableCellIssues,
  tableFloatLocked,
  tableFromDelimited,
  type TableModel,
  type TableRuleStyle,
  tableRuleStyle,
  type TableWarning,
} from '@kaxolax/editor'
import {
  Alert,
  Button,
  Checkbox,
  cn,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
  NativeSelect,
  SimpleTooltip,
  ToggleGroup,
  ToggleGroupItem,
} from '@kaxolax/ui'
import {
  BetweenHorizontalEndIcon,
  BetweenHorizontalStartIcon,
  BetweenVerticalEndIcon,
  BetweenVerticalStartIcon,
  ClipboardPasteIcon,
  Columns2Icon,
  FileUpIcon,
  type LucideIcon,
  Rows2Icon,
  TableCellsMergeIcon,
  TableCellsSplitIcon,
} from 'lucide-react'
import {
  type ClipboardEvent,
  type KeyboardEvent,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react'
import {
  anchorOf,
  type CellPosition,
  checkPackages,
  COLUMN_ALIGNS,
  cssAlign,
  type GridDirection,
  inRange,
  insertStatusMessage,
  isGridPaste,
  isTablePayload,
  moveInGrid,
  nextInReadingOrder,
  pasteIntoTable,
  rangeBetween,
} from '@/lib/writing'
import type { ActionDialogProps } from '../action-dialogs'
import { PackageNote, focusEditorOnClose } from './writing-common'

const RULE_STYLES: { value: TableRuleStyle; label: string }[] = [
  { value: 'booktabs', label: 'booktabs (filets professionnels)' },
  { value: 'classic', label: 'Classique (\\hline)' },
  { value: 'none', label: 'Sans filet horizontal' },
]

/** Lettre d'une colonne (A, B… Z, AA). */
function columnName(index: number): string {
  let name = ''
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) {
    name = String.fromCharCode(65 + ((n - 1) % 26)) + name
  }
  return name
}

/** Grille de départ : tableau sous le curseur, sélection tabulée, ou 3 × 3 vide. */
function initialState(payload: TableDialogPayload): {
  model: TableModel
  raw: { text: string; reason: string } | null
  warnings: TableWarning[]
  fromSelection: boolean
} {
  if (payload.parse?.ok === true) {
    return {
      model: cloneTable(payload.parse.model),
      raw: null,
      warnings: payload.parse.warnings,
      fromSelection: false,
    }
  }
  if (payload.parse?.ok === false) {
    return {
      model: createTable(3, 3),
      raw: { text: payload.parse.raw, reason: payload.parse.reason },
      warnings: [],
      fromSelection: false,
    }
  }
  const imported = isGridPaste(payload.selection) ? tableFromDelimited(payload.selection) : null
  // Curseur dans une figure, une minipage… : tableau seul, sans flottant `table`.
  const model = imported ?? createTable(3, 3)
  if (tableFloatLocked(payload)) model.float = null
  return {
    model,
    raw: null,
    warnings: [],
    fromSelection: imported !== null,
  }
}

/**
 * Générateur de tableaux (menu Structures) : grille éditable au clavier, lignes et colonnes,
 * fusion (`\multicolumn`, `\multirow`), alignement par colonne, filets (booktabs, classiques,
 * verticaux), collage depuis un tableur ou un CSV, légende et label, aperçu du code. Ouvert sur un
 * tableau existant, il le remplace exactement ; un tableau non représentable s'édite en texte brut.
 */
export default function TableDialog({ payload, context, onClose }: ActionDialogProps) {
  if (!isTablePayload(payload)) return null
  return <TableEditor payload={payload} context={context} onClose={onClose} />
}

function TableEditor({
  payload,
  context,
  onClose,
}: Omit<ActionDialogProps, 'payload'> & { payload: TableDialogPayload }) {
  const [initial] = useState(() => initialState(payload))
  const [model, setModel] = useState(initial.model)
  const [raw, setRaw] = useState(initial.raw)
  const [cursor, setCursor] = useState<CellPosition>({ row: 0, column: 0 })
  const [anchor, setAnchor] = useState<CellPosition | null>(null)
  const [importing, setImporting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const ids = useId()
  const cells = useRef(new Map<string, HTMLInputElement>())
  // Case à focaliser après le prochain rendu (navigation au clavier, ajout de ligne).
  const [focusRequest, setFocusRequest] = useState(0)
  const editing = payload.target !== null

  const generated = useMemo(() => generateTable(model), [model])
  const problems = useMemo(() => checkTable(model), [model])
  // Cases qui casseraient la grille ou la compilation (`20%`, `R&D`…) : insertion refusée.
  const cellIssues = useMemo(() => tableCellIssues(model), [model])
  // Légende qui casserait la compilation (`50%`, `R&D`) : même règle que les cases.
  const captionProblem = useMemo(() => captionIssue(model), [model])
  const blocked =
    raw === null && (problems.length > 0 || cellIssues.length > 0 || captionProblem !== null)
  // Tableau seul déjà dans un flottant ou une boîte (ou nouveau tableau inséré dans l'un d'eux) :
  // un second `table` ne compilerait pas.
  const floatLocked = tableFloatLocked(payload)
  const view = context().view
  const packages = view === null ? null : checkPackages(view.state.doc, generated.packages)
  const range = rangeBetween(model, anchor ?? cursor, cursor)
  const current = anchorOf(model, cursor)
  const currentCell = model.rows[current.row]?.cells[current.column] ?? null
  const ruleStyle = tableRuleStyle(model)
  const column = model.columns[current.column]
  const belowBoundary = current.row + (currentCell?.rowspan ?? 1)

  useEffect(() => {
    if (focusRequest === 0) return
    cells.current.get(`${String(current.row)}:${String(current.column)}`)?.focus()
  }, [focusRequest, current.row, current.column])

  /** Déplace le curseur (Maj : étend la plage sélectionnée) et y met le focus. */
  function moveTo(position: CellPosition, extend = false) {
    setAnchor(extend ? (anchor ?? cursor) : null)
    setCursor(position)
    setFocusRequest((value) => value + 1)
  }

  /** Applique une opération ; le curseur reste dans la grille. */
  function change(next: TableModel, position: CellPosition = cursor) {
    setModel(next)
    const row = Math.min(position.row, next.rows.length - 1)
    const col = Math.min(position.column, next.columns.length - 1)
    setCursor(anchorOf(next, { row: Math.max(0, row), column: Math.max(0, col) }))
    setAnchor(null)
    setError(null)
  }

  function onCellKeyDown(event: KeyboardEvent<HTMLInputElement>, position: CellPosition) {
    const input = event.currentTarget
    const atStart = input.selectionStart === 0 && input.selectionEnd === 0
    const atEnd =
      input.selectionStart === input.value.length && input.selectionEnd === input.value.length
    const extend = event.shiftKey && event.altKey
    const directions: Record<string, GridDirection> = {
      ArrowUp: 'up',
      ArrowDown: 'down',
      ArrowLeft: 'left',
      ArrowRight: 'right',
    }
    const direction = directions[event.key]
    if (direction !== undefined) {
      if (event.shiftKey && !event.altKey) return
      if (!extend && direction === 'left' && !atStart) return
      if (!extend && direction === 'right' && !atEnd) return
      const next = moveInGrid(model, position, direction)
      event.preventDefault()
      if (next) moveTo(next, extend)
      return
    }
    if (event.key === 'Tab') {
      const next = nextInReadingOrder(model, position, event.shiftKey)
      if (next) {
        event.preventDefault()
        moveTo(next)
      } else if (!event.shiftKey) {
        // Tab dans la dernière case : nouvelle ligne.
        event.preventDefault()
        const grown = insertRow(model, model.rows.length)
        change(grown, { row: model.rows.length, column: 0 })
        setFocusRequest((value) => value + 1)
      }
      return
    }
    if (event.key === 'Enter' && !event.ctrlKey && !event.metaKey) {
      event.preventDefault()
      const next = moveInGrid(model, position, event.shiftKey ? 'up' : 'down')
      if (next) moveTo(next)
    }
  }

  function onCellPaste(event: ClipboardEvent<HTMLInputElement>, position: CellPosition) {
    const text = event.clipboardData.getData('text/plain')
    if (!isGridPaste(text)) return
    event.preventDefault()
    change(pasteIntoTable(model, position, text), position)
  }

  function submit() {
    const { view: target, host } = context()
    if (target === null || host.readOnly === true) {
      setError('Aucun document modifiable n’est ouvert.')
      return
    }
    if (blocked) return
    // Sélection non reprise comme données : elle n'est pas remplacée par le tableau.
    if (payload.target === null && !initial.fromSelection && !target.state.selection.main.empty) {
      target.dispatch({ selection: EditorSelection.cursor(target.state.selection.main.to) })
    }
    const status = applyTable(target, payload, raw === null ? model : { raw: raw.text })
    const message = insertStatusMessage(status)
    if (message) {
      setError(message.message)
      return
    }
    onClose()
  }

  function setText(field: 'caption' | 'label', value: string) {
    const { caption, label, ...rest } = cloneTable(model)
    const texts = { caption, label, [field]: value }
    // Champ vide : clé absente (comparaison exacte avec le tableau d'origine).
    setModel({
      ...rest,
      ...(texts.caption ? { caption: texts.caption } : {}),
      ...(texts.label ? { label: texts.label } : {}),
    })
  }

  const tool = (label: string, Icon: LucideIcon, onClick: () => void, disabled = false) => (
    <SimpleTooltip label={label}>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label={label}
        disabled={disabled}
        onClick={onClick}
      >
        <Icon aria-hidden />
      </Button>
    </SimpleTooltip>
  )

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    >
      <DialogContent
        className="max-h-[94dvh] grid-rows-[auto_minmax(0,1fr)_auto] overflow-hidden sm:max-w-5xl"
        onCloseAutoFocus={(event) => {
          focusEditorOnClose(event, context)
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
            event.preventDefault()
            submit()
          }
        }}
      >
        <DialogHeader>
          <DialogTitle>{editing ? 'Modifier le tableau' : 'Nouveau tableau'}</DialogTitle>
          <DialogDescription>
            Flèches, Tab et Entrée pour naviguer ; Alt+Maj+flèches pour sélectionner des cases ;
            collez depuis un tableur ou un CSV. Ctrl+Entrée pour {editing ? 'remplacer' : 'insérer'}
            .
          </DialogDescription>
        </DialogHeader>

        <div className="grid min-h-0 content-start gap-4 overflow-y-auto pr-1">
          {raw !== null ? (
            <div className="grid gap-2">
              <Alert>
                Ce tableau ne peut pas être affiché en grille : {raw.reason} Modifiez son code
                ci-dessous.
              </Alert>
              <Label htmlFor={`${ids}-raw`}>Code du tableau</Label>
              <textarea
                id={`${ids}-raw`}
                value={raw.text}
                spellCheck={false}
                rows={14}
                onChange={(event) => {
                  setRaw({ ...raw, text: event.target.value })
                }}
                className="w-full resize-y rounded-md border border-input bg-transparent px-3 py-2 font-mono text-xs shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 dark:bg-input/30"
              />
            </div>
          ) : (
            <>
              {initial.warnings.length > 0 ? (
                <Alert>
                  <ul className="list-disc pl-4 text-xs">
                    {initial.warnings.map((warning) => (
                      <li key={warning.code + warning.message}>{warning.message}</li>
                    ))}
                  </ul>
                </Alert>
              ) : null}

              <div
                role="toolbar"
                aria-label="Structure du tableau"
                className="flex flex-wrap items-center gap-1 rounded-md border p-1"
              >
                {tool('Insérer une ligne au-dessus', BetweenHorizontalStartIcon, () => {
                  change(insertRow(model, current.row), current)
                })}
                {tool('Insérer une ligne en dessous', BetweenHorizontalEndIcon, () => {
                  change(insertRow(model, belowBoundary), {
                    row: belowBoundary,
                    column: current.column,
                  })
                })}
                {tool(
                  'Supprimer la ligne',
                  Rows2Icon,
                  () => {
                    change(deleteRow(model, current.row))
                  },
                  model.rows.length <= 1,
                )}
                <span className="mx-1 h-5 w-px bg-border" aria-hidden />
                {tool('Insérer une colonne à gauche', BetweenVerticalStartIcon, () => {
                  change(insertColumn(model, current.column), current)
                })}
                {tool('Insérer une colonne à droite', BetweenVerticalEndIcon, () => {
                  const at = current.column + (currentCell?.colspan ?? 1)
                  change(insertColumn(model, at), { row: current.row, column: at })
                })}
                {tool(
                  'Supprimer la colonne',
                  Columns2Icon,
                  () => {
                    change(deleteColumn(model, current.column))
                  },
                  model.columns.length <= 1,
                )}
                <span className="mx-1 h-5 w-px bg-border" aria-hidden />
                {tool(
                  'Fusionner les cases sélectionnées',
                  TableCellsMergeIcon,
                  () => {
                    change(mergeCells(model, range), { row: range.top, column: range.left })
                  },
                  range.top === range.bottom && range.left === range.right,
                )}
                {tool(
                  'Défusionner',
                  TableCellsSplitIcon,
                  () => {
                    change(splitCell(model, current.row, current.column), current)
                  },
                  (currentCell?.colspan ?? 1) === 1 && (currentCell?.rowspan ?? 1) === 1,
                )}
                <span className="mx-1 h-5 w-px bg-border" aria-hidden />
                {tool('Importer un fichier CSV', FileUpIcon, () => {
                  document.getElementById(`${ids}-file`)?.click()
                })}
                {tool('Coller des données (tableur, CSV)', ClipboardPasteIcon, () => {
                  setImporting((value) => !value)
                })}
                <input
                  id={`${ids}-file`}
                  type="file"
                  accept=".csv,.tsv,.txt,text/csv,text/tab-separated-values,text/plain"
                  className="hidden"
                  onChange={(event) => {
                    const file = event.target.files?.[0]
                    event.target.value = ''
                    if (!file) return
                    void file.text().then((text) => {
                      const imported = tableFromDelimited(text)
                      if (imported) change(keepLayout(model, imported), { row: 0, column: 0 })
                      else setError('Le fichier ne contient aucune donnée.')
                    })
                  }}
                />
              </div>

              {importing ? (
                <ImportPanel
                  onImport={(text) => {
                    const imported = tableFromDelimited(text)
                    if (!imported) return false
                    change(keepLayout(model, imported), { row: 0, column: 0 })
                    setImporting(false)
                    return true
                  }}
                />
              ) : null}

              <div className="overflow-auto rounded-md border">
                <table
                  role="grid"
                  aria-label="Cases du tableau"
                  aria-rowcount={model.rows.length}
                  aria-colcount={model.columns.length}
                  className="w-full border-collapse text-sm"
                >
                  <thead>
                    <tr>
                      {model.columns.map((item, c) => (
                        <th
                          key={c}
                          scope="col"
                          className={cn(
                            'border-b bg-muted/50 px-2 py-1 text-left text-xs font-medium text-muted-foreground',
                            c === current.column && 'text-foreground',
                            hasVerticalRule(model, c) && 'border-l-2 border-l-foreground/40',
                          )}
                        >
                          {columnName(c)} · {item.align}
                          {item.width === undefined ? '' : `{${item.width}}`}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {model.rows.map((row, r) => (
                      <tr
                        key={r}
                        aria-rowindex={r + 1}
                        className={cn(
                          hasHorizontalRule(model, r + 1) && 'border-b-2 border-b-foreground/40',
                          r === 0 &&
                            hasHorizontalRule(model, 0) &&
                            'border-t-2 border-t-foreground/40',
                        )}
                      >
                        {row.cells.map((cell, c) => {
                          if (cell === null) return null
                          const selected = anchor !== null && inRange(range, r, c)
                          const issue = cellIssues.find(
                            (item) => item.row === r && item.column === c,
                          )
                          return (
                            <td
                              key={c}
                              role="gridcell"
                              aria-colindex={c + 1}
                              aria-selected={selected}
                              colSpan={cell.colspan}
                              rowSpan={cell.rowspan}
                              className={cn(
                                'min-w-24 border border-border/60 p-0 align-middle',
                                selected && 'bg-accent',
                              )}
                            >
                              <input
                                ref={(element) => {
                                  const key = `${String(r)}:${String(c)}`
                                  if (element) cells.current.set(key, element)
                                  else cells.current.delete(key)
                                }}
                                value={cell.content}
                                aria-label={`Case ${columnName(c)}${String(r + 1)}`}
                                aria-invalid={issue !== undefined}
                                title={issue?.message}
                                spellCheck={false}
                                tabIndex={r === current.row && c === current.column ? 0 : -1}
                                style={{ textAlign: cssAlign(model.columns[c]?.align ?? 'l') }}
                                onFocus={() => {
                                  if (r !== cursor.row || c !== cursor.column) {
                                    setCursor({ row: r, column: c })
                                  }
                                }}
                                onMouseDown={(event) => {
                                  if (event.shiftKey) {
                                    event.preventDefault()
                                    setAnchor(anchor ?? cursor)
                                    setCursor({ row: r, column: c })
                                  } else setAnchor(null)
                                }}
                                onChange={(event) => {
                                  const next = cloneTable(model)
                                  const target = next.rows[r]?.cells[c]
                                  if (target) target.content = event.target.value
                                  setModel(next)
                                }}
                                onKeyDown={(event) => {
                                  onCellKeyDown(event, { row: r, column: c })
                                }}
                                onPaste={(event) => {
                                  onCellPaste(event, { row: r, column: c })
                                }}
                                className="h-9 w-full min-w-0 bg-transparent px-2 font-mono text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset aria-invalid:bg-destructive/10 aria-invalid:ring-1 aria-invalid:ring-destructive aria-invalid:ring-inset"
                              />
                            </td>
                          )
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <div className="grid gap-4 md:grid-cols-2">
                <fieldset className="grid content-start gap-3">
                  <legend className="mb-2 text-sm font-medium">
                    Colonne {columnName(current.column)}
                  </legend>
                  <ToggleGroup
                    type="single"
                    variant="outline"
                    size="sm"
                    aria-label="Alignement de la colonne"
                    value={column?.align && /^[lcrp]$/.test(column.align) ? column.align : ''}
                    onValueChange={(value) => {
                      if (value !== '') change(setColumnAlign(model, current.column, value))
                    }}
                  >
                    {COLUMN_ALIGNS.map((item) => (
                      <ToggleGroupItem key={item.value} value={item.value} className="px-2 text-xs">
                        {item.label}
                      </ToggleGroupItem>
                    ))}
                  </ToggleGroup>
                  {column?.align === 'p' ? (
                    <div className="flex items-center gap-2">
                      <Label htmlFor={`${ids}-width`} className="text-xs">
                        Largeur
                      </Label>
                      <Input
                        id={`${ids}-width`}
                        value={column.width ?? ''}
                        className="h-8 w-32 font-mono"
                        onChange={(event) => {
                          const width = event.target.value.replace(/[{}]/g, '')
                          setModel(
                            setColumnAlign(
                              model,
                              current.column,
                              'p',
                              width === '' ? '3cm' : width,
                            ),
                          )
                        }}
                      />
                    </div>
                  ) : null}
                  <div className="flex items-center gap-2">
                    <Checkbox
                      id={`${ids}-below`}
                      checked={hasHorizontalRule(model, belowBoundary)}
                      onCheckedChange={(checked) => {
                        change(setHorizontalRule(model, belowBoundary, checked === true))
                      }}
                    />
                    <Label htmlFor={`${ids}-below`} className="text-xs font-normal">
                      Filet sous la ligne {current.row + 1}
                    </Label>
                  </div>
                </fieldset>

                <fieldset className="grid content-start gap-3">
                  <legend className="mb-2 text-sm font-medium">Tableau</legend>
                  <div className="flex flex-wrap items-center gap-2">
                    <Label htmlFor={`${ids}-style`} className="text-xs">
                      Filets
                    </Label>
                    <NativeSelect
                      id={`${ids}-style`}
                      value={ruleStyle}
                      onChange={(event) => {
                        const value = RULE_STYLES.find((item) => item.value === event.target.value)
                        if (value) change(setTableRuleStyle(model, value.value))
                      }}
                    >
                      {RULE_STYLES.map((item) => (
                        <option key={item.value} value={item.value}>
                          {item.label}
                        </option>
                      ))}
                    </NativeSelect>
                  </div>
                  <div className="flex items-center gap-2">
                    <Checkbox
                      id={`${ids}-vertical`}
                      checked={model.separators.every((_, index) => hasVerticalRule(model, index))}
                      onCheckedChange={(checked) => {
                        change(setAllVerticalRules(model, checked === true))
                      }}
                    />
                    <Label htmlFor={`${ids}-vertical`} className="text-xs font-normal">
                      Filets verticaux
                    </Label>
                  </div>
                  <div className="flex items-center gap-2">
                    <Checkbox
                      id={`${ids}-float`}
                      checked={model.float !== null}
                      disabled={model.environment === 'longtable' || floatLocked}
                      aria-describedby={floatLocked ? `${ids}-float-locked` : undefined}
                      onCheckedChange={(checked) => {
                        const next = cloneTable(model)
                        next.float =
                          checked === true
                            ? { environment: 'table', placement: 'htbp', centering: true }
                            : null
                        setModel(next)
                      }}
                    />
                    <Label htmlFor={`${ids}-float`} className="text-xs font-normal">
                      Environnement flottant <code className="font-mono">table</code> (légende,
                      label)
                    </Label>
                  </div>
                  {floatLocked ? (
                    <p id={`${ids}-float-locked`} className="text-xs text-muted-foreground">
                      {editing
                        ? 'Ce tableau est déjà dans un flottant, une minipage ou une boîte : légende et label se modifient dans le code du document.'
                        : 'Le curseur est dans un flottant, une minipage ou une boîte : le tableau est inséré sans environnement table.'}
                    </p>
                  ) : null}
                  <div className="grid gap-2 sm:grid-cols-2">
                    <div className="grid gap-1">
                      <Label htmlFor={`${ids}-caption`} className="text-xs">
                        Légende
                      </Label>
                      <Input
                        id={`${ids}-caption`}
                        value={model.caption ?? ''}
                        disabled={model.float === null && model.environment !== 'longtable'}
                        aria-invalid={captionProblem !== null}
                        aria-describedby={captionProblem ? `${ids}-caption-issue` : undefined}
                        className="h-8 aria-invalid:border-destructive"
                        onChange={(event) => {
                          setText('caption', event.target.value)
                        }}
                      />
                      {captionProblem ? (
                        <p id={`${ids}-caption-issue`} className="text-xs text-destructive">
                          {captionProblem.message}
                        </p>
                      ) : null}
                    </div>
                    <div className="grid gap-1">
                      <Label htmlFor={`${ids}-label`} className="text-xs">
                        Label
                      </Label>
                      <Input
                        id={`${ids}-label`}
                        value={model.label ?? ''}
                        placeholder="tab:exemple"
                        disabled={model.float === null && model.environment !== 'longtable'}
                        className="h-8 font-mono"
                        onChange={(event) => {
                          setText('label', sanitizeLabel(event.target.value))
                        }}
                      />
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <Label htmlFor={`${ids}-caption-position`} className="text-xs">
                      Légende
                    </Label>
                    <NativeSelect
                      id={`${ids}-caption-position`}
                      value={model.captionPosition}
                      disabled={model.float === null}
                      onChange={(event) => {
                        const next = cloneTable(model)
                        next.captionPosition = event.target.value === 'below' ? 'below' : 'above'
                        setModel(next)
                      }}
                    >
                      <option value="above">au-dessus du tableau</option>
                      <option value="below">au-dessous du tableau</option>
                    </NativeSelect>
                  </div>
                </fieldset>
              </div>
            </>
          )}

          {raw === null ? (
            <div className="grid gap-1.5">
              <span className="text-sm font-medium">Aperçu du code</span>
              <pre className="max-h-56 overflow-auto rounded-md border bg-muted/50 px-3 py-2 font-mono text-xs">
                {generated.text}
              </pre>
              {[...problems, ...generated.warnings].map((warning) => (
                <p key={warning} className="text-xs text-amber-600 dark:text-amber-400">
                  {warning}
                </p>
              ))}
              {cellIssues.length > 0 || captionProblem !== null ? (
                <div className="flex flex-wrap items-center gap-2" role="alert">
                  <p className="text-xs text-destructive">
                    {blockingSummary(cellIssues.length, captionProblem !== null)}
                  </p>
                  {cellIssues.some((item) => item.fixable) || captionProblem?.fixable === true ? (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => {
                        setModel(fixTableCells(model))
                      }}
                    >
                      Échapper les caractères spéciaux
                    </Button>
                  ) : null}
                </div>
              ) : null}
              {packages ? <PackageNote check={packages} automatic /> : null}
            </div>
          ) : null}
        </div>

        <DialogFooter className="items-center">
          {error ? (
            <p role="alert" className="mr-auto text-sm text-destructive">
              {error}
            </p>
          ) : null}
          <Button variant="outline" onClick={onClose}>
            Annuler
          </Button>
          <Button onClick={submit} disabled={blocked}>
            {editing ? 'Remplacer' : 'Insérer'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** Message des éléments qui empêchent la compilation (cases, légende). */
function blockingSummary(cells: number, caption: boolean): string {
  const parts: string[] = []
  if (cells === 1) parts.push('une case')
  else if (cells > 1) parts.push(`${String(cells)} cases`)
  if (caption) parts.push('la légende')
  const subject = parts.join(' et ')
  return `${subject.charAt(0).toUpperCase()}${subject.slice(1)} ${
    cells + (caption ? 1 : 0) > 1 ? 'empêchent' : 'empêche'
  } la compilation : corrigez avant l’insertion.`
}

/** Grille importée avec le style, le flottant, la légende et le label du tableau en cours. */
function keepLayout(current: TableModel, imported: TableModel): TableModel {
  let next = setTableRuleStyle(imported, tableRuleStyle(current))
  next = cloneTable(next)
  next.float = current.float
  next.captionPosition = current.captionPosition
  if (current.caption !== undefined) next.caption = current.caption
  if (current.label !== undefined) next.label = current.label
  return next
}

/** Zone de collage : texte tabulé (Excel, Google Sheets) ou CSV qui remplace la grille. */
function ImportPanel({ onImport }: { onImport: (text: string) => boolean }) {
  const [text, setText] = useState('')
  const [empty, setEmpty] = useState(false)
  const id = useId()
  return (
    <div className="grid gap-2 rounded-md border p-3">
      <Label htmlFor={id}>Données à importer (tableur ou CSV, séparateur détecté)</Label>
      <textarea
        id={id}
        value={text}
        rows={5}
        autoFocus
        spellCheck={false}
        onChange={(event) => {
          setText(event.target.value)
          setEmpty(false)
        }}
        className="w-full resize-y rounded-md border border-input bg-transparent px-3 py-2 font-mono text-xs shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 dark:bg-input/30"
      />
      <div className="flex items-center gap-2">
        <Button
          size="sm"
          onClick={() => {
            setEmpty(!onImport(text))
          }}
        >
          Remplacer la grille
        </Button>
        {empty ? (
          <span role="alert" className="text-xs text-destructive">
            Aucune donnée reconnue.
          </span>
        ) : null}
      </div>
    </div>
  )
}
