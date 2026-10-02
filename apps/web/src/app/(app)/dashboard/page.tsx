'use client'

import { UserButton } from '@clerk/nextjs'
import {
  Alert,
  Badge,
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Input,
  Logo,
  Skeleton,
  cn,
} from '@kaxolax/ui'
import {
  ArrowDownUpIcon,
  EllipsisIcon,
  FileArchiveIcon,
  FileTextIcon,
  PlusIcon,
  SearchIcon,
} from 'lucide-react'
import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useRequiredUser } from '@/components/auth/session'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { DashboardSidebar, PROJECT_VIEWS } from '@/components/dashboard/dashboard-sidebar'
import { NameDialog } from '@/components/name-dialog'
import { COMPILERS } from '@/components/workspace/pdf/compile-status'
import { WorkspaceSwitcher } from '@/components/workspace/sidebar/sidebar-footer'
import {
  api,
  errorMessage,
  importZip,
  type Project,
  type ProjectView,
  type Workspace,
} from '@/lib/api'

const ROLE_LABELS: Record<Project['role'], string> = {
  owner: 'Propriétaire',
  editor: 'Éditeur',
  reviewer: 'Relecteur',
  viewer: 'Lecteur',
}

const SORTS = [
  { id: 'date', label: 'Plus récents' },
  { id: 'name', label: 'Par nom' },
] as const
type Sort = (typeof SORTS)[number]['id']

const dateFormat = new Intl.DateTimeFormat('fr-FR', { dateStyle: 'medium', timeStyle: 'short' })

/**
 * Tableau de bord : projets du workspace choisi (ou de tous, partagés compris), vues actifs,
 * archivés et corbeille, recherche, tri, création, import d'un zip, et actions par projet
 * (renommer, archiver, corbeille, restaurer, supprimer). Le workspace vient de l'URL
 * (`?workspace=`), réglée par le sélecteur du pied de sidebar.
 */
export default function DashboardPage() {
  const user = useRequiredUser()
  const router = useRouter()
  const searchParams = useSearchParams()
  const workspaceId = searchParams.get('workspace')
  const [view, setView] = useState<ProjectView>('active')
  const [search, setSearch] = useState('')
  const [query, setQuery] = useState('')
  const [sort, setSort] = useState<Sort>('date')
  const [workspaces, setWorkspaces] = useState<Workspace[]>([])
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
      setProjects((await api.projects(view, query, workspaceId)).projects)
    } catch (caught) {
      setError(errorMessage(caught))
    }
  }, [view, query, workspaceId])

  useEffect(() => {
    if (!user) return
    let active = true
    api.workspaces().then(
      ({ workspaces: loaded }) => {
        if (active) setWorkspaces(loaded)
      },
      (caught: unknown) => {
        if (active) setError(errorMessage(caught))
      },
    )
    return () => {
      active = false
    }
  }, [user])

  useEffect(() => {
    if (!user) return
    let active = true
    api.projects(view, query, workspaceId).then(
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
  }, [user, view, query, workspaceId])

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
      const project = await importZip(file, workspaceId)
      router.push(`/project/${project.id}`)
    } catch (caught) {
      setError(errorMessage(caught))
      setImporting(false)
    }
  }

  const changeView = (next: ProjectView) => {
    setProjects(null)
    setView(next)
  }
  const workspace = workspaces.find((candidate) => candidate.id === workspaceId)
  const viewLabel = PROJECT_VIEWS.find((item) => item.id === view)?.label ?? 'Projets'

  return (
    <div className="flex h-dvh">
      <DashboardSidebar
        user={user}
        view={view}
        workspaceId={workspaceId}
        importing={importing}
        onViewChange={changeView}
        onCreate={() => {
          setCreating(true)
        }}
        onImport={() => importInput.current?.click()}
      />
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

      <div className="flex min-w-0 flex-1 flex-col overflow-auto bg-background">
        {/* Écran étroit : la sidebar laisse place à une barre (logo, workspace, création, compte). */}
        <header className="flex h-bar shrink-0 items-center gap-2 border-b bg-sidebar px-3 text-sidebar-foreground md:hidden">
          <Logo size={22} title="" />
          <span className="font-semibold tracking-tight">Kaxolax</span>
          <WorkspaceSwitcher
            workspaceId={workspaceId}
            allLabel="Tous les workspaces"
            side="bottom"
            className="ml-2 min-w-0"
          />
          <Button
            variant="accent"
            size="sm"
            className="ml-auto"
            aria-label="Nouveau projet"
            onClick={() => {
              setCreating(true)
            }}
          >
            <PlusIcon />
          </Button>
          <UserButton userProfileUrl="/account" userProfileMode="navigation" />
        </header>

        <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-6 md:px-8">
          <div className="mb-5">
            <div>
              <h1 className="text-2xl font-semibold tracking-tight">{viewLabel}</h1>
              <p className="text-sm text-muted-foreground">
                {workspace?.name ?? 'Tous les workspaces'}
              </p>
            </div>
          </div>

          <nav aria-label="Vues" className="mb-4 flex rounded-md border p-0.5 md:hidden">
            {PROJECT_VIEWS.map((item) => (
              <button
                key={item.id}
                type="button"
                aria-current={view === item.id ? 'page' : undefined}
                onClick={() => {
                  changeView(item.id)
                }}
                className={cn(
                  'flex-1 rounded px-3 py-1 text-sm',
                  view === item.id
                    ? 'bg-primary text-primary-foreground'
                    : 'text-muted-foreground hover:text-foreground',
                )}
              >
                {item.label}
              </button>
            ))}
          </nav>

          <div className="mb-4 flex flex-wrap items-center gap-2">
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
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" aria-label="Trier">
                  <ArrowDownUpIcon /> {SORTS.find((item) => item.id === sort)?.label}
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuRadioGroup
                  value={sort}
                  onValueChange={(value) => {
                    setSort(value === 'name' ? 'name' : 'date')
                  }}
                >
                  {SORTS.map((item) => (
                    <DropdownMenuRadioItem key={item.id} value={item.id}>
                      {item.label}
                    </DropdownMenuRadioItem>
                  ))}
                </DropdownMenuRadioGroup>
              </DropdownMenuContent>
            </DropdownMenu>
            <Button
              variant="outline"
              className="md:hidden"
              disabled={importing}
              onClick={() => importInput.current?.click()}
            >
              <FileArchiveIcon /> {importing ? 'Import…' : 'Importer'}
            </Button>
          </div>

          {error ? (
            <Alert variant="destructive" className="mb-4">
              {error}
            </Alert>
          ) : null}

          <div className="overflow-hidden rounded-lg border bg-card">
            {projects === null ? (
              <div className="divide-y">
                {[0, 1, 2].map((index) => (
                  <div key={index} className="flex items-center gap-3 px-4 py-3">
                    <Skeleton className="size-9 rounded-md" />
                    <div className="grid flex-1 gap-1.5">
                      <Skeleton className="h-4 w-48" />
                      <Skeleton className="h-3 w-32" />
                    </div>
                  </div>
                ))}
                <span className="sr-only">Chargement…</span>
              </div>
            ) : null}
            {projects !== null && sorted.length === 0 ? (
              <div className="flex flex-col items-center gap-3 px-6 py-12 text-center">
                <FileTextIcon className="size-8 text-muted-foreground" />
                <p className="text-sm text-muted-foreground">
                  {view === 'active'
                    ? 'Aucun projet pour l’instant. Créez-en un ou importez un zip.'
                    : view === 'archived'
                      ? 'Aucun projet archivé.'
                      : 'La corbeille est vide.'}
                </p>
              </div>
            ) : null}
            <ul className="divide-y">
              {sorted.map((project) => (
                <li
                  key={project.id}
                  className="group flex items-center gap-3 px-4 py-3 hover:bg-muted/50"
                  data-testid="project-row"
                >
                  <span className="flex size-9 shrink-0 items-center justify-center rounded-md bg-editor text-editor-foreground">
                    <FileTextIcon className="size-4" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <Link
                      href={`/project/${project.id}`}
                      className="block truncate font-medium outline-none hover:underline focus-visible:underline"
                    >
                      {project.name}
                    </Link>
                    <p className="truncate text-xs text-muted-foreground">
                      Modifié le {dateFormat.format(new Date(project.updatedAt))} ·{' '}
                      {COMPILERS.find((compiler) => compiler.id === project.compiler)?.label ??
                        project.compiler}
                    </p>
                  </div>
                  {project.role !== 'owner' ? (
                    <Badge variant="secondary" className="hidden sm:inline-flex">
                      Partagé · {ROLE_LABELS[project.role]}
                    </Badge>
                  ) : null}
                  <ProjectMenu
                    project={project}
                    view={view}
                    onRename={() => {
                      setRenaming(project)
                    }}
                    onDelete={() => {
                      setDeleting(project)
                    }}
                    onAct={(action) => void act(() => api.setProjectState(project.id, action))}
                  />
                </li>
              ))}
            </ul>
          </div>
        </main>
      </div>

      <NameDialog
        open={creating}
        onOpenChange={setCreating}
        title="Nouveau projet"
        label="Nom du projet"
        submitLabel="Créer"
        onSubmit={async (name) => {
          const { project } = await api.createProject(name, workspaceId)
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

/** Actions d'un projet selon la vue : renommer, archiver, corbeille, restaurer, supprimer. */
function ProjectMenu({
  project,
  view,
  onRename,
  onDelete,
  onAct,
}: {
  project: Project
  view: ProjectView
  onRename: () => void
  onDelete: () => void
  onAct: (action: 'archive' | 'unarchive' | 'trash' | 'restore') => void
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon-sm" aria-label={`Actions pour ${project.name}`}>
          <EllipsisIcon />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {view !== 'trashed' ? (
          <DropdownMenuItem onSelect={onRename}>Renommer</DropdownMenuItem>
        ) : null}
        {view === 'active' ? (
          <DropdownMenuItem
            onSelect={() => {
              onAct('archive')
            }}
          >
            Archiver
          </DropdownMenuItem>
        ) : null}
        {view === 'archived' ? (
          <DropdownMenuItem
            onSelect={() => {
              onAct('unarchive')
            }}
          >
            Désarchiver
          </DropdownMenuItem>
        ) : null}
        {view !== 'trashed' ? (
          <DropdownMenuItem
            variant="destructive"
            onSelect={() => {
              onAct('trash')
            }}
          >
            Mettre à la corbeille
          </DropdownMenuItem>
        ) : (
          <>
            <DropdownMenuItem
              onSelect={() => {
                onAct('restore')
              }}
            >
              Restaurer
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onSelect={onDelete}>
              Supprimer définitivement
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
