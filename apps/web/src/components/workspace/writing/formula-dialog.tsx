'use client'

import {
  FORMULA_CATEGORIES,
  FORMULA_LIBRARY,
  type FormulaCategory,
  type FormulaDialogPayload,
  type FormulaStyle,
  applyFormula,
  formulaInsertion,
  sanitizeLabel,
} from '@kaxolax/editor'
import {
  Alert,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
  Spinner,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  ToggleGroup,
  ToggleGroupItem,
} from '@kaxolax/ui'
import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { checkPackages, insertStatusMessage, isFormulaPayload } from '@/lib/writing'
import type { ActionDialogProps } from '../action-dialogs'
import { loadMathLive, MathField, type MathFieldHandle, type MathFieldStatus } from './math-field'
import { PackageNote, focusEditorOnClose } from './writing-common'

const STYLES: { value: FormulaStyle; label: string }[] = [
  { value: 'inline', label: 'En ligne' },
  { value: 'display', label: 'Centrée' },
  { value: 'equation', label: 'Numérotée' },
]

/**
 * Éditeur de formules (menu Maths, Ctrl+Maj+E) : saisie visuelle MathLive chargée à la demande,
 * LaTeX éditable en texte brut, bibliothèque de formules, présentation (en ligne, centrée,
 * numérotée avec label) et aperçu du texte inséré. Ouvert sur une formule existante, il la
 * remplace exactement (délimiteurs et label gardés).
 */
export default function FormulaDialog({ payload, context, onClose }: ActionDialogProps) {
  if (!isFormulaPayload(payload)) return null
  return <FormulaEditor payload={payload} context={context} onClose={onClose} />
}

function FormulaEditor({
  payload,
  context,
  onClose,
}: Omit<ActionDialogProps, 'payload'> & { payload: FormulaDialogPayload }) {
  const [latex, setLatex] = useState(payload.initial)
  const [style, setStyle] = useState<FormulaStyle>(payload.style)
  const [label, setLabel] = useState(payload.label)
  const [status, setStatus] = useState<MathFieldStatus>('loading')
  const [error, setError] = useState<string | null>(null)
  const field = useRef<MathFieldHandle>(null)
  const ids = useId()

  const insertion = useMemo(
    () => formulaInsertion(payload, { latex, style, label }),
    [payload, latex, style, label],
  )
  const view = context().view
  const packages = view === null ? null : checkPackages(view.state.doc, insertion.packages)
  const empty = latex.trim() === ''
  const editing = payload.formula !== null
  // LaTeX qui ne compilerait pas (accolade non fermée, `$`, `&` hors alignement…) : refusé.
  const blocked = empty || insertion.errors.length > 0

  function submit() {
    if (blocked) return
    const current = context()
    if (current.view === null || current.host.readOnly === true) {
      setError('Aucun document modifiable n’est ouvert.')
      return
    }
    const result = applyFormula(current.view, payload, { latex, style, label })
    const message = insertStatusMessage(result)
    if (message) {
      setError(message.message)
      return
    }
    onClose()
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    >
      <DialogContent
        className="max-h-[92dvh] grid-rows-[auto_minmax(0,1fr)_auto] overflow-hidden sm:max-w-4xl"
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
          <DialogTitle>{editing ? 'Modifier la formule' : 'Éditeur de formules'}</DialogTitle>
          <DialogDescription>
            Saisie visuelle ou LaTeX ; Ctrl+Entrée pour {editing ? 'remplacer' : 'insérer'}.
          </DialogDescription>
        </DialogHeader>

        <div className="grid min-h-0 gap-4 overflow-y-auto pr-1 lg:grid-cols-[minmax(0,1fr)_17rem]">
          <div className="grid min-w-0 content-start gap-3">
            <div className="grid gap-1.5">
              <span className="text-sm font-medium" id={`${ids}-visual`}>
                Formule
              </span>
              {status === 'loading' ? (
                <div className="flex h-14 items-center gap-2 rounded-md border border-input px-3 text-sm text-muted-foreground">
                  <Spinner className="size-4" /> Chargement de l’éditeur visuel…
                </div>
              ) : null}
              {status === 'error' ? (
                <Alert variant="destructive">
                  L’éditeur visuel n’a pas pu être chargé : modifiez le LaTeX ci-dessous.
                </Alert>
              ) : null}
              <div className={status === 'ready' ? undefined : 'hidden'}>
                <MathField
                  ref={field}
                  value={latex}
                  label="Formule (éditeur visuel)"
                  onChange={setLatex}
                  onStatus={setStatus}
                  onSubmit={submit}
                />
              </div>
            </div>

            <div className="grid gap-1.5">
              <Label htmlFor={`${ids}-latex`}>LaTeX</Label>
              <textarea
                id={`${ids}-latex`}
                value={latex}
                onChange={(event) => {
                  setLatex(event.target.value)
                }}
                spellCheck={false}
                rows={3}
                className="min-h-16 w-full resize-y rounded-md border border-input bg-transparent px-3 py-2 font-mono text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 dark:bg-input/30"
              />
            </div>

            <div className="flex flex-wrap items-end gap-3">
              <div className="grid gap-1.5">
                <span className="text-sm font-medium" id={`${ids}-style`}>
                  Présentation
                </span>
                <ToggleGroup
                  type="single"
                  variant="outline"
                  size="sm"
                  value={style}
                  aria-labelledby={`${ids}-style`}
                  onValueChange={(value) => {
                    if (value === 'inline' || value === 'display' || value === 'equation') {
                      setStyle(value)
                    }
                  }}
                >
                  {STYLES.map((item) => (
                    <ToggleGroupItem key={item.value} value={item.value} className="px-3">
                      {item.label}
                    </ToggleGroupItem>
                  ))}
                </ToggleGroup>
              </div>
              {style === 'equation' ? (
                <div className="grid min-w-40 flex-1 gap-1.5">
                  <Label htmlFor={`${ids}-label`}>Label</Label>
                  <Input
                    id={`${ids}-label`}
                    value={label}
                    placeholder="eq:exemple"
                    maxLength={100}
                    onChange={(event) => {
                      setLabel(sanitizeLabel(event.target.value))
                    }}
                    className="h-8 font-mono"
                  />
                </div>
              ) : null}
            </div>

            <div className="grid gap-1.5">
              <span className="text-sm font-medium">
                {editing ? 'Texte remplacé par' : 'Texte inséré'}
              </span>
              <pre
                className="max-h-40 overflow-auto rounded-md border bg-muted/50 px-3 py-2 font-mono text-xs whitespace-pre-wrap"
                aria-live="polite"
              >
                {empty ? '—' : insertion.text}
              </pre>
              {insertion.warnings.map((warning) => (
                <p key={warning} className="text-xs text-amber-600 dark:text-amber-400">
                  {warning}
                </p>
              ))}
              {!empty && insertion.errors.length > 0 ? (
                <div role="alert" className="text-xs text-destructive">
                  <p>Cette formule ne compilerait pas : corrigez-la avant l’insertion.</p>
                  <ul className="list-disc pl-4">
                    {insertion.errors.map((item) => (
                      <li key={item}>{item}</li>
                    ))}
                  </ul>
                </div>
              ) : null}
              {packages && !empty ? <PackageNote check={packages} automatic /> : null}
            </div>
          </div>

          <FormulaLibrary
            onPick={(entry) => {
              if (empty && entry.display && style === 'inline' && !editing) setStyle('display')
              if (status === 'ready' && field.current) field.current.insert(entry.template)
              else
                setLatex((current) =>
                  current.trim() === '' ? entry.latex : `${current} ${entry.latex}`,
                )
            }}
          />
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

type LibraryEntry = (typeof FORMULA_LIBRARY)[number]

/** Bibliothèque de formules courantes, par catégorie ; aperçu rendu par MathLive une fois chargé. */
function FormulaLibrary({ onPick }: { onPick: (entry: LibraryEntry) => void }) {
  const [category, setCategory] = useState<FormulaCategory>(FORMULA_CATEGORIES[0].id)
  const previews = useLibraryPreviews()
  return (
    <section aria-label="Bibliothèque de formules" className="grid min-w-0 content-start gap-2">
      <span className="text-sm font-medium">Bibliothèque</span>
      <Tabs
        value={category}
        onValueChange={(value) => {
          const found = FORMULA_CATEGORIES.find((item) => item.id === value)
          if (found) setCategory(found.id)
        }}
        className="gap-2"
      >
        <TabsList
          aria-label="Catégories de formules"
          className="flex h-auto w-full flex-wrap justify-start gap-1 p-1"
        >
          {FORMULA_CATEGORIES.map((item) => (
            <TabsTrigger key={item.id} value={item.id} className="h-7 flex-none px-2 text-xs">
              {item.label}
            </TabsTrigger>
          ))}
        </TabsList>
        {FORMULA_CATEGORIES.map((item) => (
          <TabsContent key={item.id} value={item.id} className="grid gap-1">
            {FORMULA_LIBRARY.filter((entry) => entry.category === item.id).map((entry) => (
              <button
                key={entry.id}
                type="button"
                title={entry.latex}
                onClick={() => {
                  onPick(entry)
                }}
                className="grid gap-1 rounded-md border border-transparent px-2 py-1.5 text-left text-xs hover:border-border hover:bg-accent focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
              >
                <span className="font-medium">{entry.label}</span>
                {previews?.get(entry.id) ? (
                  <span
                    className="kx-math-preview"
                    aria-hidden
                    // Balisage produit par MathLive à partir des formules du catalogue (constantes).
                    dangerouslySetInnerHTML={{ __html: previews.get(entry.id) ?? '' }}
                  />
                ) : (
                  <code className="truncate font-mono text-muted-foreground">{entry.latex}</code>
                )}
              </button>
            ))}
          </TabsContent>
        ))}
      </Tabs>
    </section>
  )
}

/** Aperçus des formules de la bibliothèque (balisage MathLive), une fois MathLive chargé. */
function useLibraryPreviews(): ReadonlyMap<string, string> | null {
  const [previews, setPreviews] = useState<ReadonlyMap<string, string> | null>(null)
  useEffect(() => {
    let active = true
    loadMathLive().then(
      ({ convertLatexToMarkup }) => {
        if (!active) return
        const map = new Map<string, string>()
        for (const entry of FORMULA_LIBRARY) {
          try {
            map.set(entry.id, convertLatexToMarkup(entry.latex))
          } catch {
            // Formule non rendue : le code LaTeX reste affiché.
          }
        }
        setPreviews(map)
      },
      () => undefined,
    )
    return () => {
      active = false
    }
  }, [])
  return previews
}
