'use client'

import {
  Button,
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@kaxolax/ui'
import { CheckIcon, ChevronDownIcon, FolderIcon, LayoutGridIcon, PlusIcon } from 'lucide-react'
import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { NameDialog } from '@/components/name-dialog'
import { api, type Project } from '@/lib/api'

/** Projets récents proposés par le sélecteur. */
const RECENT_PROJECTS = 8

/**
 * Sélecteur de projet (nom ▾) : projets récents, recherche, nouveau projet (dans le workspace du
 * projet courant), retour au tableau de bord.
 */
export function ProjectSwitcher({ project }: { project: Project | null }) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [creating, setCreating] = useState(false)
  const [projects, setProjects] = useState<Project[] | null>(null)
  const [search, setSearch] = useState('')
  // Sans recherche, seuls les plus récents ; la recherche porte sur tous les projets actifs.
  const shown = search.trim() === '' ? (projects ?? []).slice(0, RECENT_PROJECTS) : (projects ?? [])

  function onOpenChange(next: boolean) {
    setOpen(next)
    setSearch('')
    // Liste rechargée à chaque ouverture (projets créés ou renommés ailleurs).
    if (next)
      api.projects('active', '').then(
        ({ projects: loaded }) => {
          setProjects([...loaded].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)))
        },
        () => {
          setProjects([])
        },
      )
  }

  return (
    <>
      <Popover open={open} onOpenChange={onOpenChange}>
        <PopoverTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            className="min-w-0 flex-1 justify-start gap-1 px-2 text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
            aria-label="Changer de projet"
          >
            <span className="truncate font-semibold" data-testid="project-name">
              {project?.name ?? ''}
            </span>
            <ChevronDownIcon className="size-3.5 shrink-0 text-sidebar-muted-foreground" />
          </Button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-72 p-0">
          <Command search={search} onSearchChange={setSearch}>
            <CommandInput placeholder="Rechercher un projet…" aria-label="Rechercher un projet" />
            <CommandList>
              <CommandEmpty>{projects === null ? 'Chargement…' : 'Aucun projet.'}</CommandEmpty>
              <CommandGroup heading={search.trim() === '' ? 'Projets récents' : 'Projets'}>
                {shown.map((candidate) => (
                  <CommandItem
                    key={candidate.id}
                    value={candidate.name}
                    keywords={[candidate.id]}
                    onSelect={() => {
                      setOpen(false)
                      if (candidate.id !== project?.id) router.push(`/project/${candidate.id}`)
                    }}
                  >
                    <FolderIcon />
                    <span className="truncate">{candidate.name}</span>
                    {candidate.id === project?.id ? <CheckIcon className="ml-auto" /> : null}
                  </CommandItem>
                ))}
              </CommandGroup>
              <CommandSeparator />
              <CommandGroup>
                <CommandItem
                  value="Nouveau projet"
                  forceMount
                  onSelect={() => {
                    setOpen(false)
                    setCreating(true)
                  }}
                >
                  <PlusIcon /> Nouveau projet
                </CommandItem>
                <CommandItem
                  value="Tableau de bord"
                  forceMount
                  onSelect={() => {
                    setOpen(false)
                    router.push('/dashboard')
                  }}
                >
                  <LayoutGridIcon /> Tableau de bord
                </CommandItem>
              </CommandGroup>
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
      <NameDialog
        key={creating ? 'creating' : 'idle'}
        open={creating}
        onOpenChange={setCreating}
        title="Nouveau projet"
        label="Nom du projet"
        submitLabel="Créer"
        onSubmit={async (name) => {
          const { project: created } = await api.createProject(name, project?.workspaceId ?? null)
          router.push(`/project/${created.id}`)
        }}
      />
    </>
  )
}
