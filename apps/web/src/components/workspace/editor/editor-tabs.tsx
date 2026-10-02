'use client'

import {
  Button,
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  Popover,
  PopoverContent,
  PopoverTrigger,
  SimpleTooltip,
  cn,
} from '@kaxolax/ui'
import { FileIcon, FilePlusIcon, FileTextIcon, ImageIcon, PlusIcon, XIcon } from 'lucide-react'
import { type ReactNode, useState } from 'react'
import type { ProjectTree } from '@/lib/api'
import { moveTabFocus } from '@/lib/keyboard'
import { useFileActions } from '../file-actions'

/** Onglet d'un document (CodeMirror) ou d'un fichier binaire (aperçu). */
export interface OpenTab {
  id: string
  name: string
  path: string
  kind: 'document' | 'file'
  mimeType?: string
}

function TabIcon({
  tab,
  className,
}: {
  tab: Pick<OpenTab, 'kind' | 'mimeType'>
  className?: string
}) {
  if (tab.kind === 'document') return <FileTextIcon className={className} />
  if (tab.mimeType?.startsWith('image/')) return <ImageIcon className={className} />
  return <FileIcon className={className} />
}

/**
 * Barre d'onglets des fichiers ouverts : onglet actif encadré, fermeture au survol (ou clic du
 * milieu, ou Suppr sur l'onglet focalisé), bouton + pour ouvrir un fichier du projet ou en créer
 * un. Clavier : flèches entre les onglets, Entrée pour activer. `leading` et `trailing`
 * accueillent les boutons de la page (sidebar, état de synchronisation, Tools).
 */
export function EditorTabs({
  tabs,
  activeId,
  tree,
  onActivate,
  onClose,
  leading,
  trailing,
}: {
  tabs: readonly OpenTab[]
  activeId: string | null
  tree: ProjectTree | null
  onActivate: (id: string) => void
  onClose: (id: string) => void
  leading?: ReactNode
  trailing?: ReactNode
}) {
  return (
    <div className="flex h-bar shrink-0 items-center gap-1 border-b border-editor-border bg-editor-tabbar px-1.5">
      {leading}
      <div
        role="tablist"
        aria-label="Fichiers ouverts"
        className="flex min-w-0 items-center gap-1 overflow-x-auto [scrollbar-width:none]"
        onKeyDown={moveTabFocus}
      >
        {tabs.map((tab, index) => {
          const active = tab.id === activeId
          // Un seul onglet dans l'ordre de tabulation : l'actif (sinon le premier).
          const tabStop = active || (activeId === null && index === 0)
          return (
            <div
              key={tab.id}
              className={cn(
                'group flex h-tab shrink-0 items-center rounded-md border text-sm',
                active
                  ? 'border-editor-tab-active-border bg-editor-tab-active text-editor-tab-active-foreground'
                  : 'border-transparent text-editor-tab-foreground hover:bg-editor-tab-active/60',
              )}
            >
              <button
                type="button"
                role="tab"
                aria-selected={active}
                tabIndex={tabStop ? 0 : -1}
                title={tab.path}
                data-testid="editor-tab"
                data-tab-path={tab.path}
                className="flex h-full max-w-48 items-center gap-1.5 pl-2.5 pr-1 outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
                onClick={() => {
                  onActivate(tab.id)
                }}
                onAuxClick={(event) => {
                  if (event.button === 1) onClose(tab.id)
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Delete') {
                    event.preventDefault()
                    onClose(tab.id)
                  }
                }}
              >
                <TabIcon tab={tab} className="size-3.5 shrink-0 opacity-70" />
                <span className="truncate">{tab.name}</span>
              </button>
              <button
                type="button"
                aria-label={`Fermer ${tab.name}`}
                // Hors de l'ordre de tabulation : Suppr sur l'onglet le ferme.
                tabIndex={-1}
                className="mr-1 flex size-5 items-center justify-center rounded-sm opacity-0 hover:bg-editor-border group-hover:opacity-100"
                onClick={() => {
                  onClose(tab.id)
                }}
              >
                <XIcon className="size-3" />
              </button>
            </div>
          )
        })}
      </div>
      <OpenFileButton tree={tree} onOpen={onActivate} />
      <div className="ml-auto flex shrink-0 items-center gap-1.5">{trailing}</div>
    </div>
  )
}

/** Bouton + : ouvrir un fichier du projet (recherche par chemin) ou en créer un. */
function OpenFileButton({
  tree,
  onOpen,
}: {
  tree: ProjectTree | null
  onOpen: (id: string) => void
}) {
  const files = useFileActions()
  const [open, setOpen] = useState(false)
  const entries = [
    ...(tree?.documents ?? []).map((document) => ({
      id: document.id,
      path: document.path,
      kind: 'document' as const,
    })),
    ...(tree?.files ?? []).map((file) => ({
      id: file.id,
      path: file.path,
      kind: 'file' as const,
      mimeType: file.mimeType,
    })),
  ].sort((a, b) => a.path.localeCompare(b.path))

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <SimpleTooltip label="Ouvrir ou créer un fichier">
        <PopoverTrigger asChild>
          <Button
            variant="ghost"
            size="icon-xs"
            className="shrink-0 text-editor-tab-foreground hover:bg-editor-tab-active hover:text-editor-tab-active-foreground"
            aria-label="Ouvrir ou créer un fichier"
          >
            <PlusIcon />
          </Button>
        </PopoverTrigger>
      </SimpleTooltip>
      <PopoverContent align="start" className="w-80 p-0">
        <Command>
          <CommandInput placeholder="Ouvrir un fichier…" aria-label="Rechercher un fichier" />
          <CommandList>
            <CommandEmpty>Aucun fichier.</CommandEmpty>
            {files.canEdit ? (
              <CommandGroup>
                <CommandItem
                  value="Nouveau fichier"
                  forceMount
                  onSelect={() => {
                    setOpen(false)
                    files.createDocument(null)
                  }}
                >
                  <FilePlusIcon /> Nouveau fichier…
                </CommandItem>
              </CommandGroup>
            ) : null}
            <CommandGroup heading="Fichiers du projet">
              {entries.map((entry) => (
                <CommandItem
                  key={entry.id}
                  value={entry.path}
                  onSelect={() => {
                    setOpen(false)
                    onOpen(entry.id)
                  }}
                >
                  <TabIcon tab={entry} />
                  <span className="truncate font-mono text-xs">{entry.path}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}
