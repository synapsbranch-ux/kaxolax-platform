'use client'

import {
  Alert,
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Input,
  NativeSelect,
  cn,
} from '@kaxolax/ui'
import { EllipsisIcon, FileArchiveIcon, PlusIcon, SearchIcon } from 'lucide-react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AppHeader } from '@/components/app-header'
import { useRequiredUser } from '@/components/auth/session'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { NameDialog } from '@/components/name-dialog'
import { api, errorMessage, importZip, type Project, type ProjectView } from '@/lib/api'

const VIEWS: { id: ProjectView; label: string }[] = [
  { id: 'active', label: 'Actifs' },
  { id: 'archived', label: 'Archivés' },
  { id: 'trashed', label: 'Corbeille' },
]

const dateFormat = new Intl.DateTimeFormat('fr-FR', { dateStyle: 'medium', timeStyle: 'short' })

export default function DashboardPage() {
  const user = useRequiredUser()
  const router = useRouter()
  const [view, setView] = useState<ProjectView>('active')
  const [search, setSearch] = useState('')
  const [query, setQuery] = useState('')
  const [sort, setSort] = useState<'date' | 'name'>('date')
  const [projects, setProjects] = useState<Project[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [renaming, setRenaming] = useState<Project | null>(null)
  const [deleting, setDeleting] = useState<Project | null>(null)
  const [importing, setImporting] = useState(false)
  const importInput = useRef<HTMLInputElement>(null)

  // Recherche envoyée à l'API 300 ms après la dernière frappe.
  useEffect(() => {
    const timer = setTimeout(() => {
      setQuery(search)
    }, 300)
    return () => {
      clearTimeout(timer)
    }
  }, [search])

  const load = useCallback(async () => {
    try {
      setProjects((await api.projects(view, query)).projects)
    } catch (caught) {
      setError(errorMessage(caught))
    }
  }, [view, query])

  useEffect(() => {
    if (!user) return
    let active = true
    api.projects(view, query).then(
      ({ projects: loaded }) => {
        if (active) setProjects(loaded)
      },
      (caught: unknown) => {
        if (active) setError(errorMessage(caught))
      },
    )
    return () => {
      active = false
    }
  }, [user, view, query])

  const sorted = useMemo(
    () =>
      [...(projects ?? [])].sort((a, b) =>
        sort === 'name' ? a.name.localeCompare(b.name) : b.updatedAt.localeCompare(a.updatedAt),
      ),
    [projects, sort],
  )

  async function act(action: () => Promise<unknown>) {
    setError(null)
    try {
      await action()
      await load()
    } catch (caught) {
      setError(errorMessage(caught))
    }
  }

  async function onImport(file: File) {
    setImporting(true)
    setError(null)
    try {
      const project = await importZip(file)
      router.push(`/project/${project.id}`)
    } catch (caught) {
      setError(errorMessage(caught))
      setImporting(false)
    }
  }

  return (
    <div className="flex min-h-screen flex-col">
      <AppHeader user={user} />
      <main className="mx-auto w-full max-w-5xl flex-1 p-6">
        <div className="mb-6 flex flex-wrap items-center gap-3">
          <h1 className="mr-auto text-2xl font-semibold">Projets</h1>
          <Button
            onClick={() => {
              setCreating(true)
            }}
          >
            <PlusIcon /> Nouveau projet
          </Button>
          <Button
            variant="outline"
            disabled={importing}
            onClick={() => importInput.current?.click()}
          >
            <FileArchiveIcon /> {importing ? 'Import en cours…' : 'Importer un zip'}
          </Button>
          <input
            ref={importInput}
            type="file"
            accept=".zip,application/zip"
            className="hidden"
            data-testid="import-input"
            onChange={(event) => {
              const file = event.target.files?.[0]
              event.target.value = ''
              if (file) void onImport(file)
            }}
          />
        </div>

        <div className="mb-4 flex flex-wrap items-center gap-3">
          <nav className="flex rounded-md border p-0.5" aria-label="Vues">
            {VIEWS.map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={() => {
                  setView(item.id)
                }}
                className={cn(
                  'rounded px-3 py-1 text-sm',
                  view === item.id
                    ? 'bg-primary text-primary-foreground'
                    : 'text-muted-foreground hover:text-foreground',
                )}
              >
                {item.label}
              </button>
            ))}
          </nav>
          <div className="relative min-w-48 flex-1">
            <SearchIcon className="pointer-events-none absolute left-2.5 top-2.5 size-4 text-muted-foreground" />
            <Input
              placeholder="Rechercher un projet"
              className="pl-8"
              value={search}
              onChange={(event) => {
                setSearch(event.target.value)
              }}
              aria-label="Rechercher"
            />
          </div>
          <NativeSelect
            value={sort}
            onChange={(event) => {
              setSort(event.target.value as 'date' | 'name')
            }}
            aria-label="Trier"
          >
            <option value="date">Plus récents</option>
            <option value="name">Par nom</option>
          </NativeSelect>
        </div>

        {error ? (
          <Alert variant="destructive" className="mb-4">
            {error}
          </Alert>
        ) : null}

        <div className="divide-y rounded-lg border">
          {projects === null ? (
            <p className="p-6 text-sm text-muted-foreground">Chargement…</p>
          ) : null}
          {projects !== null && sorted.length === 0 ? (
            <p className="p-6 text-sm text-muted-foreground">
              {view === 'active'
                ? 'Aucun projet pour l’instant. Créez-en un ou importez un zip.'
                : 'Rien ici.'}
            </p>
          ) : null}
          {sorted.map((project) => (
            <div
              key={project.id}
              className="flex items-center gap-3 px-4 py-3"
              data-testid="project-row"
            >
              <div className="min-w-0 flex-1">
                <Link href={`/project/${project.id}`} className="font-medium hover:underline">
                  {project.name}
                </Link>
                <p className="text-xs text-muted-foreground">
                  Modifié le {dateFormat.format(new Date(project.updatedAt))} · {project.compiler}
                </p>
              </div>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={`Actions pour ${project.name}`}
                  >
                    <EllipsisIcon />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  {view !== 'trashed' ? (
                    <DropdownMenuItem
                      onSelect={() => {
                        setRenaming(project)
                      }}
                    >
                      Renommer
                    </DropdownMenuItem>
                  ) : null}
                  {view === 'active' ? (
                    <DropdownMenuItem
                      onSelect={() => void act(() => api.setProjectState(project.id, 'archive'))}
                    >
                      Archiver
                    </DropdownMenuItem>
                  ) : null}
                  {view === 'archived' ? (
                    <DropdownMenuItem
                      onSelect={() => void act(() => api.setProjectState(project.id, 'unarchive'))}
                    >
                      Désarchiver
                    </DropdownMenuItem>
                  ) : null}
                  {view !== 'trashed' ? (
                    <DropdownMenuItem
                      variant="destructive"
                      onSelect={() => void act(() => api.setProjectState(project.id, 'trash'))}
                    >
                      Mettre à la corbeille
                    </DropdownMenuItem>
                  ) : (
                    <>
                      <DropdownMenuItem
                        onSelect={() => void act(() => api.setProjectState(project.id, 'restore'))}
                      >
                        Restaurer
                      </DropdownMenuItem>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem
                        variant="destructive"
                        onSelect={() => {
                          setDeleting(project)
                        }}
                      >
                        Supprimer définitivement
                      </DropdownMenuItem>
                    </>
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          ))}
        </div>
      </main>

      <NameDialog
        open={creating}
        onOpenChange={setCreating}
        title="Nouveau projet"
        label="Nom du projet"
        submitLabel="Créer"
        onSubmit={async (name) => {
          const { project } = await api.createProject(name)
          router.push(`/project/${project.id}`)
        }}
      />
      <NameDialog
        key={renaming?.id}
        open={renaming !== null}
        onOpenChange={(open) => {
          if (!open) setRenaming(null)
        }}
        title="Renommer le projet"
        label="Nom du projet"
        initialValue={renaming?.name}
        submitLabel="Renommer"
        onSubmit={async (name) => {
          if (renaming) await api.updateProject(renaming.id, { name })
          await load()
        }}
      />
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => {
          if (!open) setDeleting(null)
        }}
        title="Supprimer définitivement ?"
        description={`« ${deleting?.name ?? ''} » et tous ses fichiers seront supprimés. Cette action est irréversible.`}
        confirmLabel="Supprimer"
        onConfirm={() => {
          if (deleting) void act(() => api.deleteProject(deleting.id))
        }}
      />
    </div>
  )
}
