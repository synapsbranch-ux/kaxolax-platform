'use client'

import { SearchIcon } from 'lucide-react'
import type * as React from 'react'
import {
  createContext,
  useCallback,
  useContext,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'
import { matchesSearch } from '../lib/search.js'
import { cn } from '../utils.js'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from './dialog.js'
import { useShortcutText } from './kbd.js'

/** Filtre d'un élément : `true` s'il doit rester visible pour cette recherche. */
export type CommandFilter = (search: string, value: string, keywords: readonly string[]) => boolean

interface ItemRecord {
  value: string
  keywords: readonly string[]
  groupId: string | undefined
  disabled: boolean
  forceMount: boolean
}

/**
 * Registre des éléments montés : la racine sait combien restent visibles (CommandEmpty) et
 * dans quels groupes (CommandGroup), y compris pour les éléments filtrés qui ne rendent rien.
 */
class ItemRegistry {
  #records = new Map<string, ItemRecord>()
  #snapshot: readonly ItemRecord[] = []
  #listeners = new Set<() => void>()

  subscribe = (listener: () => void) => {
    this.#listeners.add(listener)
    return () => {
      this.#listeners.delete(listener)
    }
  }

  getSnapshot = (): readonly ItemRecord[] => this.#snapshot

  set(id: string, record: ItemRecord) {
    const previous = this.#records.get(id)
    if (
      previous?.value === record.value &&
      previous.groupId === record.groupId &&
      previous.disabled === record.disabled &&
      previous.forceMount === record.forceMount &&
      previous.keywords.join('\n') === record.keywords.join('\n')
    ) {
      return
    }
    this.#records.set(id, record)
    this.#emit()
  }

  delete(id: string) {
    if (this.#records.delete(id)) this.#emit()
  }

  #emit() {
    this.#snapshot = [...this.#records.values()]
    for (const listener of this.#listeners) listener()
  }
}

interface CommandContextValue {
  registry: ItemRegistry
  search: string
  setSearch: (search: string) => void
  isVisible: (record: Pick<ItemRecord, 'value' | 'keywords' | 'forceMount'>) => boolean
  visibleCount: number
  visibleGroups: ReadonlySet<string>
  activeId: string | undefined
  setActiveId: (id: string | undefined) => void
  listId: string
}

const CommandContext = createContext<CommandContextValue | null>(null)
const CommandGroupContext = createContext<string | undefined>(undefined)

function useCommandContext(component: string): CommandContextValue {
  const context = useContext(CommandContext)
  if (!context) throw new Error(`${component} must be used inside <Command>`)
  return context
}

/** Éléments activables, dans l'ordre du document. */
function enabledItems(root: HTMLElement | null): HTMLElement[] {
  if (!root) return []
  return Array.from(
    root.querySelectorAll<HTMLElement>('[data-slot="command-item"]:not([data-disabled])'),
  )
}

export interface CommandProps extends Omit<React.ComponentProps<'div'>, 'onSelect' | 'ref'> {
  /** Recherche contrôlée ; sinon gérée par le composant (`defaultSearch`). */
  search?: string
  defaultSearch?: string
  onSearchChange?: (search: string) => void
  /** `false` : aucun filtrage, l'appelant ne rend que les résultats (recherche côté serveur). */
  shouldFilter?: boolean
  /** Filtre des éléments ; par défaut `matchesSearch` (mots, sans casse ni accents). */
  filter?: CommandFilter
  /** Les flèches reviennent au début après le dernier élément. */
  loop?: boolean
}

/**
 * Palette de recherche : un champ, une liste filtrée et navigable au clavier (↑ ↓, Entrée).
 * Composition : Command > CommandInput + CommandList > CommandGroup > CommandItem.
 */
export function Command({
  className,
  search: controlledSearch,
  defaultSearch = '',
  onSearchChange,
  shouldFilter = true,
  filter = matchesSearch,
  loop = true,
  onKeyDown,
  children,
  ...props
}: CommandProps) {
  const [registry] = useState(() => new ItemRegistry())
  const records = useSyncExternalStore(
    registry.subscribe,
    registry.getSnapshot,
    registry.getSnapshot,
  )
  const [ownSearch, setOwnSearch] = useState(defaultSearch)
  const search = controlledSearch ?? ownSearch
  const [activeId, setActiveId] = useState<string>()
  const rootRef = useRef<HTMLDivElement>(null)
  const lastSearchRef = useRef(search)
  const listId = useId()

  const setSearch = useCallback(
    (next: string) => {
      if (controlledSearch === undefined) setOwnSearch(next)
      onSearchChange?.(next)
    },
    [controlledSearch, onSearchChange],
  )

  const isVisible = useCallback(
    (record: Pick<ItemRecord, 'value' | 'keywords' | 'forceMount'>) =>
      record.forceMount || !shouldFilter || filter(search, record.value, record.keywords),
    [filter, search, shouldFilter],
  )

  const { visibleCount, visibleGroups } = useMemo(() => {
    let count = 0
    const groups = new Set<string>()
    for (const record of records) {
      if (!isVisible(record)) continue
      count++
      if (record.groupId !== undefined) groups.add(record.groupId)
    }
    return { visibleCount: count, visibleGroups: groups }
  }, [records, isVisible])

  // Après le rendu : l'élément actif reste celui choisi s'il est encore là ; une nouvelle
  // recherche repart du premier résultat.
  useLayoutEffect(() => {
    const items = enabledItems(rootRef.current)
    const searchChanged = lastSearchRef.current !== search
    lastSearchRef.current = search
    const current = searchChanged ? undefined : items.find((item) => item.id === activeId)
    const nextId = (current ?? items[0])?.id
    if (nextId !== activeId) setActiveId(nextId)
  }, [activeId, records, search])

  function move(direction: 1 | -1) {
    const items = enabledItems(rootRef.current)
    if (items.length === 0) return
    const index = items.findIndex((item) => item.id === activeId)
    let next: number
    if (index === -1) next = direction === 1 ? 0 : items.length - 1
    else if (loop) next = (index + direction + items.length) % items.length
    else next = Math.min(items.length - 1, Math.max(0, index + direction))
    const target = items[next]
    if (!target) return
    setActiveId(target.id)
    target.scrollIntoView({ block: 'nearest' })
  }

  function handleKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    onKeyDown?.(event)
    if (event.defaultPrevented || event.nativeEvent.isComposing) return
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      move(event.key === 'ArrowDown' ? 1 : -1)
    } else if (event.key === 'Enter') {
      const active = enabledItems(rootRef.current).find((item) => item.id === activeId)
      if (!active) return
      event.preventDefault()
      active.click()
    }
  }

  const context = useMemo<CommandContextValue>(
    () => ({
      registry,
      search,
      setSearch,
      isVisible,
      visibleCount,
      visibleGroups,
      activeId,
      setActiveId,
      listId,
    }),
    [registry, search, setSearch, isVisible, visibleCount, visibleGroups, activeId, listId],
  )

  return (
    <CommandContext value={context}>
      <div
        {...props}
        ref={rootRef}
        data-slot="command"
        className={cn(
          'flex size-full flex-col overflow-hidden rounded-md bg-popover text-popover-foreground',
          className,
        )}
        onKeyDown={handleKeyDown}
      >
        {children}
      </div>
    </CommandContext>
  )
}

/** Champ de recherche (combobox) ; donner un `aria-label` ou un `placeholder` explicite. */
export function CommandInput({
  className,
  onChange,
  ...props
}: Omit<React.ComponentProps<'input'>, 'value' | 'defaultValue' | 'type'>) {
  const { search, setSearch, listId, activeId } = useCommandContext('CommandInput')
  return (
    <div
      data-slot="command-input-wrapper"
      className="flex h-10 shrink-0 items-center gap-2 border-b px-3"
    >
      <SearchIcon aria-hidden className="size-4 shrink-0 opacity-50" />
      <input
        {...props}
        data-slot="command-input"
        type="text"
        role="combobox"
        aria-expanded
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={activeId}
        autoComplete="off"
        autoCorrect="off"
        spellCheck={false}
        value={search}
        onChange={(event) => {
          onChange?.(event)
          setSearch(event.target.value)
        }}
        className={cn(
          'flex h-10 w-full bg-transparent py-3 text-sm outline-hidden placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-50',
          className,
        )}
      />
    </div>
  )
}

export function CommandList({ className, ...props }: React.ComponentProps<'div'>) {
  const { listId } = useCommandContext('CommandList')
  return (
    <div
      data-slot="command-list"
      role="listbox"
      id={listId}
      className={cn('max-h-80 scroll-py-1 overflow-y-auto overflow-x-hidden p-1', className)}
      {...props}
    />
  )
}

/** Affiché quand aucun élément ne correspond à la recherche. */
export function CommandEmpty({ className, ...props }: React.ComponentProps<'div'>) {
  const { visibleCount } = useCommandContext('CommandEmpty')
  if (visibleCount > 0) return null
  return (
    <div
      data-slot="command-empty"
      role="presentation"
      className={cn('py-6 text-center text-sm text-muted-foreground', className)}
      {...props}
    />
  )
}

/** Groupe titré ; masqué quand aucun de ses éléments ne correspond à la recherche. */
export function CommandGroup({
  className,
  heading,
  children,
  ...props
}: React.ComponentProps<'div'> & { heading?: React.ReactNode }) {
  const { visibleGroups } = useCommandContext('CommandGroup')
  const groupId = useId()
  const headingId = useId()
  return (
    <div
      data-slot="command-group"
      role="presentation"
      hidden={!visibleGroups.has(groupId)}
      className={cn('overflow-hidden text-foreground', className)}
      {...props}
    >
      {heading ? (
        <div
          id={headingId}
          aria-hidden
          data-slot="command-group-heading"
          className="px-2 py-1.5 text-xs font-medium text-muted-foreground"
        >
          {heading}
        </div>
      ) : null}
      <div role="group" aria-labelledby={heading ? headingId : undefined}>
        <CommandGroupContext value={groupId}>{children}</CommandGroupContext>
      </div>
    </div>
  )
}

export interface CommandItemProps extends Omit<React.ComponentProps<'div'>, 'onSelect'> {
  /** Texte filtré et rendu à `onSelect` (souvent le libellé, ou un identifiant). */
  value: string
  /** Autres textes qui doivent trouver l'élément (synonymes, chemin du fichier). */
  keywords?: readonly string[]
  disabled?: boolean
  /** Toujours affiché, quelle que soit la recherche (« Créer le fichier … »). */
  forceMount?: boolean
  onSelect?: (value: string) => void
}

export function CommandItem({
  className,
  value,
  keywords,
  disabled = false,
  forceMount = false,
  onSelect,
  onClick,
  onPointerMove,
  children,
  ...props
}: CommandItemProps) {
  const { registry, isVisible, activeId, setActiveId } = useCommandContext('CommandItem')
  const groupId = useContext(CommandGroupContext)
  const id = useId()
  // Clé stable : un tableau recréé à chaque rendu ne réenregistre pas l'élément.
  const keywordsKey = keywords?.join('\n') ?? ''

  useLayoutEffect(() => {
    registry.set(id, {
      value,
      keywords: keywordsKey === '' ? [] : keywordsKey.split('\n'),
      groupId,
      disabled,
      forceMount,
    })
  }, [registry, id, value, keywordsKey, groupId, disabled, forceMount])

  useLayoutEffect(
    () => () => {
      registry.delete(id)
    },
    [registry, id],
  )

  if (!isVisible({ value, keywords: keywords ?? [], forceMount })) return null
  const active = activeId === id

  return (
    <div
      {...props}
      id={id}
      data-slot="command-item"
      role="option"
      aria-selected={active}
      aria-disabled={disabled || undefined}
      data-selected={active ? '' : undefined}
      data-disabled={disabled ? '' : undefined}
      onPointerMove={(event) => {
        onPointerMove?.(event)
        if (!disabled && !active) setActiveId(id)
      }}
      onClick={(event) => {
        onClick?.(event)
        if (!disabled) onSelect?.(value)
      }}
      className={cn(
        "relative flex cursor-default select-none items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-hidden data-[selected]:bg-accent data-[selected]:text-accent-foreground data-[disabled]:pointer-events-none data-[disabled]:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4 [&_svg:not([class*='text-'])]:text-muted-foreground",
        className,
      )}
    >
      {children}
    </div>
  )
}

/** Séparateur entre groupes ; masqué pendant une recherche, sauf `alwaysRender`. */
export function CommandSeparator({
  className,
  alwaysRender = false,
  ...props
}: React.ComponentProps<'div'> & { alwaysRender?: boolean }) {
  const { search } = useCommandContext('CommandSeparator')
  if (search !== '' && !alwaysRender) return null
  return (
    <div
      data-slot="command-separator"
      role="separator"
      className={cn('-mx-1 my-1 h-px bg-border', className)}
      {...props}
    />
  )
}

/** Raccourci d'un élément : `shortcut` au format CodeMirror, ou texte en enfant. */
export function CommandShortcut({
  className,
  shortcut,
  children,
  ...props
}: React.ComponentProps<'span'> & { shortcut?: string }) {
  const text = useShortcutText(shortcut)
  return (
    <span
      data-slot="command-shortcut"
      className={cn('ml-auto pl-4 text-xs tracking-widest text-muted-foreground', className)}
      {...props}
    >
      {text ?? children}
    </span>
  )
}

/** Palette dans une modale (titre et description lus par les lecteurs d'écran). */
export function CommandDialog({
  open,
  defaultOpen,
  onOpenChange,
  modal,
  title = 'Palette de commandes',
  description = 'Rechercher une commande à exécuter',
  className,
  children,
  ...props
}: CommandProps &
  Pick<React.ComponentProps<typeof Dialog>, 'open' | 'defaultOpen' | 'onOpenChange' | 'modal'> & {
    title?: string
    description?: string
  }) {
  return (
    <Dialog open={open} defaultOpen={defaultOpen} onOpenChange={onOpenChange} modal={modal}>
      <DialogContent className="gap-0 overflow-hidden p-0" showCloseButton={false}>
        <DialogHeader className="sr-only">
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <Command
          className={cn(
            '[&_[data-slot=command-input-wrapper]]:h-12 [&_[data-slot=command-input]]:h-12',
            className,
          )}
          {...props}
        >
          {children}
        </Command>
      </DialogContent>
    </Dialog>
  )
}
