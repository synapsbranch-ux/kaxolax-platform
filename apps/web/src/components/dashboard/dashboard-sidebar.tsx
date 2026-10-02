'use client'

import { Button, Logo, cn } from '@kaxolax/ui'
import { ArchiveIcon, FileArchiveIcon, FolderIcon, PlusIcon, Trash2Icon } from 'lucide-react'
import Link from 'next/link'
import type { ProjectView, User } from '@/lib/api'
import { SidebarFooter } from '@/components/workspace/sidebar/sidebar-footer'

export const PROJECT_VIEWS: { id: ProjectView; label: string; icon: typeof FolderIcon }[] = [
  { id: 'active', label: 'Projets', icon: FolderIcon },
  { id: 'archived', label: 'Archivés', icon: ArchiveIcon },
  { id: 'trashed', label: 'Corbeille', icon: Trash2Icon },
]

/**
 * Colonne de gauche du tableau de bord, dans le langage de la page projet (sidebar sombre) :
 * logo, nouveau projet et import, vues (actifs, archivés, corbeille), et pied (utilisateur,
 * sélecteur de workspace, compte). Masquée sous 768 px (barre du haut à la place).
 */
export function DashboardSidebar({
  user,
  view,
  workspaceId,
  importing,
  onViewChange,
  onCreate,
  onImport,
}: {
  user: User | null
  view: ProjectView
  workspaceId: string | null
  importing: boolean
  onViewChange: (view: ProjectView) => void
  onCreate: () => void
  onImport: () => void
}) {
  return (
    <aside
      aria-label="Navigation"
      className="hidden w-60 shrink-0 flex-col bg-sidebar text-sidebar-foreground md:flex [--avatar-stack-ring:var(--sidebar)]"
    >
      <div className="flex h-bar shrink-0 items-center px-3">
        <Link
          href="/dashboard"
          className="flex items-center gap-2 rounded-md font-semibold tracking-tight outline-none focus-visible:ring-[3px] focus-visible:ring-sidebar-ring/50"
        >
          <Logo size={22} title="" />
          Kaxolax
        </Link>
      </div>
      <div className="grid gap-1.5 px-3 pb-3">
        <Button variant="accent" className="justify-start" onClick={onCreate}>
          <PlusIcon /> Nouveau projet
        </Button>
        <Button
          variant="ghost"
          className="justify-start text-sidebar-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
          disabled={importing}
          onClick={onImport}
        >
          <FileArchiveIcon /> {importing ? 'Import en cours…' : 'Importer un zip'}
        </Button>
      </div>
      <nav aria-label="Vues" className="grid gap-0.5 px-2">
        {PROJECT_VIEWS.map((item) => (
          <button
            key={item.id}
            type="button"
            aria-current={view === item.id ? 'page' : undefined}
            onClick={() => {
              onViewChange(item.id)
            }}
            className={cn(
              'flex h-8 items-center gap-2 rounded-md px-2.5 text-sm outline-none focus-visible:ring-[3px] focus-visible:ring-sidebar-ring/50',
              view === item.id
                ? 'bg-sidebar-accent font-medium text-sidebar-accent-foreground'
                : 'text-sidebar-muted-foreground hover:bg-sidebar-accent/60 hover:text-sidebar-foreground',
            )}
          >
            <item.icon className="size-4" />
            {item.label}
          </button>
        ))}
      </nav>
      <div className="mt-auto">
        <SidebarFooter user={user} workspaceId={workspaceId} allLabel="Tous les workspaces" />
      </div>
    </aside>
  )
}
