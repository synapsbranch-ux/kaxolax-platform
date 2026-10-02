'use client'

import {
  addPackage,
  insertSymbol,
  type LatexSymbol,
  parseRecentSymbols,
  pushRecentSymbol,
  recentSymbols,
  searchSymbols,
  SYMBOL_CATEGORIES,
  SYMBOLS,
  type SymbolsDialogPayload,
} from '@kaxolax/editor'
import {
  Button,
  Checkbox,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
  Tabs,
  TabsList,
  TabsTrigger,
} from '@kaxolax/ui'
import { SearchIcon } from 'lucide-react'
import { type KeyboardEvent, useId, useMemo, useRef, useState } from 'react'
import { usePreferences } from '@/components/preferences/preferences-provider'
import { checkPackages, isSymbolsPayload } from '@/lib/writing'
import type { ActionDialogProps } from '../action-dialogs'
import { PackageNote, focusEditorOnClose } from './writing-common'

const RECENT_TAB = 'recent'

/**
 * Sélecteur de symboles (menu Maths) : palette par catégorie, recherche par nom (français,
 * anglais, commande), symboles récents (préférences de l'utilisateur, tous appareils). Un symbole
 * mathématique inséré hors formule est placé dans `\( \)` ; un package manquant est proposé en un
 * clic et peut être ajouté à l'insertion.
 */
export default function SymbolsDialog({ payload, context, onClose }: ActionDialogProps) {
  if (!isSymbolsPayload(payload)) return null
  return <SymbolPicker payload={payload} context={context} onClose={onClose} />
}

function SymbolPicker({
  payload,
  context,
  onClose,
}: Omit<ActionDialogProps, 'payload'> & { payload: SymbolsDialogPayload }) {
  const { preferences, update } = usePreferences()
  const recent = useMemo(
    () => parseRecentSymbols(preferences.recentSymbols),
    [preferences.recentSymbols],
  )
  const [tab, setTab] = useState<string>(() =>
    recent.length > 0 ? RECENT_TAB : SYMBOL_CATEGORIES[0].id,
  )
  const [query, setQuery] = useState('')
  const [active, setActive] = useState<LatexSymbol | null>(null)
  const [addPackages, setAddPackages] = useState(true)
  // Relecture du préambule après un ajout de package.
  const [, setRevision] = useState(0)
  const ids = useId()

  const shown = useMemo(() => {
    if (query.trim() !== '') return searchSymbols(query)
    if (tab === RECENT_TAB) return recentSymbols(recent)
    return SYMBOLS.filter((symbol) => symbol.category === tab)
  }, [query, tab, recent])
  const current = active !== null && shown.includes(active) ? active : (shown[0] ?? null)
  const view = context().view
  const packages =
    current === null || view === null ? null : checkPackages(view.state.doc, current.packages)

  // Une seule insertion par ouverture (Entrée et Ctrl+Entrée peuvent arriver ensemble).
  const inserted = useRef(false)

  function insert(symbol: LatexSymbol) {
    const { view: target, host } = context()
    if (inserted.current || target === null || host.readOnly === true) return
    if (!insertSymbol(target, symbol, { addPackages })) return
    inserted.current = true
    update({ recentSymbols: pushRecentSymbol(recent, symbol.id) })
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
        className="max-h-[92dvh] grid-rows-[auto_auto_minmax(0,1fr)_auto] overflow-hidden sm:max-w-2xl"
        onCloseAutoFocus={(event) => {
          focusEditorOnClose(event, context)
        }}
        onKeyDown={(event) => {
          // Touche déjà traitée plus bas (recherche, palette).
          if (event.defaultPrevented) return
          if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
            event.preventDefault()
            if (current) insert(current)
          }
        }}
      >
        <DialogHeader>
          <DialogTitle>Symboles</DialogTitle>
          <DialogDescription>
            {payload.math
              ? 'Insertion dans la formule sous le curseur (un symbole texte y est placé dans \\text{…}).'
              : 'Hors formule : un symbole mathématique est placé dans \\( … \\).'}
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-2">
          <div className="relative">
            <SearchIcon
              className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
              aria-hidden
            />
            <Input
              type="search"
              value={query}
              placeholder="Rechercher (flèche, alpha, \\leq…)"
              aria-label="Rechercher un symbole"
              className="pl-8"
              autoFocus
              onChange={(event) => {
                setQuery(event.target.value)
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && current) {
                  event.preventDefault()
                  event.stopPropagation()
                  insert(current)
                } else if (event.key === 'ArrowDown') {
                  event.preventDefault()
                  document
                    .getElementById(`${ids}-palette`)
                    ?.querySelector<HTMLElement>('[tabindex="0"]')
                    ?.focus()
                }
              }}
            />
          </div>
          {query.trim() === '' ? (
            <Tabs value={tab} onValueChange={setTab}>
              <TabsList
                aria-label="Catégories de symboles"
                className="flex h-auto w-full flex-wrap justify-start gap-1 p-1"
              >
                <TabsTrigger value={RECENT_TAB} className="h-7 flex-none px-2 text-xs">
                  Récents
                </TabsTrigger>
                {SYMBOL_CATEGORIES.map((category) => (
                  <TabsTrigger
                    key={category.id}
                    value={category.id}
                    className="h-7 flex-none px-2 text-xs"
                  >
                    {category.label}
                  </TabsTrigger>
                ))}
              </TabsList>
            </Tabs>
          ) : (
            <p className="text-xs text-muted-foreground" aria-live="polite">
              {shown.length === 0
                ? 'Aucun symbole trouvé.'
                : `${String(shown.length)} symbole${shown.length > 1 ? 's' : ''}`}
            </p>
          )}
        </div>

        <Palette
          id={`${ids}-palette`}
          symbols={shown}
          active={current}
          emptyText={
            tab === RECENT_TAB && query.trim() === ''
              ? 'Les symboles insérés apparaîtront ici.'
              : 'Aucun symbole.'
          }
          onActive={setActive}
          onPick={insert}
        />

        <DialogFooter className="items-start sm:items-center sm:justify-between">
          <div className="grid min-w-0 gap-1.5" aria-live="polite">
            {current ? (
              <div className="flex min-w-0 items-center gap-3">
                <span className="w-10 shrink-0 text-center text-3xl leading-none" aria-hidden>
                  {current.glyph}
                </span>
                <div className="min-w-0 text-sm">
                  <div className="truncate font-medium first-letter:uppercase">
                    {current.name.fr}
                  </div>
                  <code className="font-mono text-xs text-muted-foreground">
                    {current.argument ? `${current.command}{…}` : current.command}
                  </code>
                  {current.mode === 'text' ? (
                    <span className="ml-2 text-xs text-muted-foreground">(texte)</span>
                  ) : null}
                </div>
              </div>
            ) : null}
            {packages ? (
              <PackageNote
                check={packages}
                onAdd={(names) => {
                  const target = context().view
                  if (target === null) return
                  for (const name of names) addPackage(target, name)
                  setRevision((value) => value + 1)
                }}
              />
            ) : null}
            <div className="flex items-center gap-2">
              <Checkbox
                id={`${ids}-auto`}
                checked={addPackages}
                onCheckedChange={(checked) => {
                  setAddPackages(checked === true)
                }}
              />
              <Label htmlFor={`${ids}-auto`} className="text-xs font-normal">
                Ajouter les packages manquants à l’insertion
              </Label>
            </div>
          </div>
          <div className="flex gap-2">
            <Button variant="outline" onClick={onClose}>
              Fermer
            </Button>
            <Button
              disabled={current === null}
              onClick={() => {
                if (current) insert(current)
              }}
            >
              Insérer
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** Nombre de colonnes affichées par la grille CSS (navigation haut/bas). */
function gridColumns(element: HTMLElement): number {
  const template = getComputedStyle(element).gridTemplateColumns
  return Math.max(1, template.split(' ').filter((part) => part !== '').length)
}

/**
 * Palette : grille de symboles à focus itinérant (un seul arrêt de tabulation ; flèches, Début,
 * Fin ; Entrée ou Espace insère).
 */
function Palette({
  id,
  symbols,
  active,
  emptyText,
  onActive,
  onPick,
}: {
  id: string
  symbols: readonly LatexSymbol[]
  active: LatexSymbol | null
  emptyText: string
  onActive: (symbol: LatexSymbol) => void
  onPick: (symbol: LatexSymbol) => void
}) {
  const grid = useRef<HTMLDivElement>(null)

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (active === null || grid.current === null) return
    const index = symbols.indexOf(active)
    const columns = gridColumns(grid.current)
    const moves: Record<string, number> = {
      ArrowLeft: index - 1,
      ArrowRight: index + 1,
      ArrowUp: index - columns,
      ArrowDown: index + columns,
      Home: 0,
      End: symbols.length - 1,
    }
    const next = moves[event.key]
    if (next === undefined) return
    event.preventDefault()
    const target = symbols[Math.min(symbols.length - 1, Math.max(0, next))]
    if (!target) return
    onActive(target)
    grid.current.querySelector<HTMLElement>(`[data-symbol="${CSS.escape(target.id)}"]`)?.focus()
  }

  if (symbols.length === 0) {
    return (
      <p className="py-8 text-center text-sm text-muted-foreground" id={id}>
        {emptyText}
      </p>
    )
  }
  return (
    <div
      ref={grid}
      id={id}
      role="listbox"
      aria-label="Symboles"
      onKeyDown={onKeyDown}
      className="grid min-h-0 grid-cols-[repeat(auto-fill,minmax(2.75rem,1fr))] content-start gap-1 overflow-y-auto p-0.5"
    >
      {symbols.map((symbol) => {
        const selected = symbol === active
        return (
          <button
            key={symbol.id}
            type="button"
            role="option"
            aria-selected={selected}
            aria-label={`${symbol.name.fr} (${symbol.command})`}
            title={`${symbol.name.fr} — ${symbol.command}${symbol.packages.length > 0 ? ` (${symbol.packages.join(', ')})` : ''}`}
            data-symbol={symbol.id}
            tabIndex={selected ? 0 : -1}
            onFocus={() => {
              onActive(symbol)
            }}
            onMouseEnter={() => {
              onActive(symbol)
            }}
            onClick={() => {
              onPick(symbol)
            }}
            className="flex h-11 items-center justify-center rounded-md border border-transparent text-xl hover:bg-accent focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none aria-selected:border-border aria-selected:bg-accent"
          >
            <span aria-hidden>{symbol.glyph}</span>
          </button>
        )
      })}
    </div>
  )
}
