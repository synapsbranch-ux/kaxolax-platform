'use client'

import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Logo,
  SimpleTooltip,
  Skeleton,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  cn,
} from '@kaxolax/ui'
import {
  FilePlusIcon,
  FolderPlusIcon,
  PanelLeftCloseIcon,
  PlusIcon,
  SearchIcon,
  UploadIcon,
} from 'lucide-react'
import Link from 'next/link'
import type { ProjectSearchMatch } from '@kaxolax/contracts'
import { type ReactNode, useState } from 'react'
import type { Project, ProjectTree, User } from '@/lib/api'
import { useFileActions } from '../file-actions'
import { ChatsPanel } from './chats-panel'
import { FileTree } from './file-tree'
import { OutlineSection } from './outline-section'
import { PresenceStack } from './presence-stack'
import { ProjectSearch } from './project-search'
import { ProjectSwitcher } from './project-switcher'
import { ShareButton } from './share-dialog'
import { SidebarFooter } from './sidebar-footer'

const iconButton =
  'text-sidebar-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground'

/**
 * Colonne de gauche : logo et repli, sélecteur de projet, présence et invitation, onglets Fichiers et
 * Chats (recherche dans le projet, menu +), plan du document et pied (utilisateur, workspace,
 * compte). Les emplacements des tâches suivantes y sont posés (présence, partage, chat).
 */
export function Sidebar({
  project,
  tree,
  user,
  activeId,
  onOpen,
  onCollapse,
  collapseLabel = 'Replier la barre latérale',
  search,
  onSearchProject,
  onCloseSearch,
  onOpenMatch,
  outline,
}: {
  project: Project | null
  tree: ProjectTree | null
  user: User | null
  activeId: string | null
  onOpen: (id: string) => void
  /** Repli (colonne) ou fermeture (tiroir sur un écran étroit). */
  onCollapse: () => void
  collapseLabel?: string
  /** Panneau de recherche dans le projet ouvert (null : fermé) et demande d'ouverture courante. */
  search: { query: string; serial: number } | null
  /** Ouvre la recherche dans tout le projet (icône loupe). */
  onSearchProject: (query: string) => void
  onCloseSearch: () => void
  /** Ouvre le fichier d'un résultat et sélectionne l'occurrence. */
  onOpenMatch: (match: ProjectSearchMatch) => void
  /** Plan du document (section Outline). */
  outline?: ReactNode
}) {
  const files = useFileActions()
  const [tab, setTab] = useState<'files' | 'chats'>('files')

  return (
    <aside
      aria-label="Barre latérale"
      className="flex h-full min-w-0 flex-col bg-sidebar text-sidebar-foreground [--avatar-stack-ring:var(--sidebar)]"
    >
      <div className="flex h-bar shrink-0 items-center gap-2 px-3">
        <Link
          href="/dashboard"
          className="flex items-center gap-2 rounded-md font-semibold tracking-tight outline-none focus-visible:ring-[3px] focus-visible:ring-sidebar-ring/50"
          aria-label="Kaxolax, tableau de bord"
        >
          <Logo size={22} title="" />
          <span>Kaxolax</span>
        </Link>
        <SimpleTooltip label={collapseLabel}>
          <Button
            variant="ghost"
            size="icon-sm"
            className={`ml-auto ${iconButton}`}
            aria-label={collapseLabel}
            data-testid="sidebar-collapse"
            onClick={onCollapse}
          >
            <PanelLeftCloseIcon />
          </Button>
        </SimpleTooltip>
      </div>

      <div className="flex shrink-0 items-center gap-1 px-2 pb-2">
        <ProjectSwitcher project={project} />
        <PresenceStack />
        <ShareButton project={project} />
      </div>

      <Tabs
        value={tab}
        onValueChange={(value) => {
          setTab(value === 'chats' ? 'chats' : 'files')
          onCloseSearch()
        }}
        className="min-h-0 flex-1 gap-0"
      >
        <div className="flex shrink-0 items-center gap-1 border-b border-sidebar-border px-2">
          <TabsList variant="line" className="h-9">
            <TabsTrigger
              value="files"
              className="text-sidebar-muted-foreground data-[state=active]:text-sidebar-foreground"
            >
              Fichiers
            </TabsTrigger>
            <TabsTrigger
              value="chats"
              className="text-sidebar-muted-foreground data-[state=active]:text-sidebar-foreground"
            >
              Chats
            </TabsTrigger>
          </TabsList>
          <div className="ml-auto flex items-center">
            <SimpleTooltip label="Rechercher dans le projet" shortcut="Mod-Shift-f">
              <Button
                variant="ghost"
                size="icon-xs"
                className={iconButton}
                aria-label="Rechercher dans le projet"
                aria-pressed={search !== null}
                onClick={() => {
                  if (search === null) onSearchProject('')
                  else onCloseSearch()
                }}
                data-testid="project-search-button"
              >
                <SearchIcon />
              </Button>
            </SimpleTooltip>
            {files.canEdit ? (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    className={iconButton}
                    aria-label="Ajouter"
                    data-testid="sidebar-add"
                  >
                    <PlusIcon />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem
                    onSelect={() => {
                      files.createDocument(null)
                    }}
                  >
                    <FilePlusIcon /> Nouveau fichier
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onSelect={() => {
                      files.createFolder(null)
                    }}
                  >
                    <FolderPlusIcon /> Nouveau dossier
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onSelect={() => {
                      files.chooseUploads(null)
                    }}
                  >
                    <UploadIcon /> Uploader des fichiers
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            ) : null}
          </div>
        </div>
        {/* La recherche remplace le contenu des onglets (classe plutôt que l'attribut hidden, que
            Radix impose déjà à l'onglet inactif). */}
        {search !== null && project ? (
          <ProjectSearch
            projectId={project.id}
            request={search}
            onOpenMatch={onOpenMatch}
            onClose={onCloseSearch}
          />
        ) : null}
        <TabsContent value="files" className={cn('min-h-0', search !== null && 'hidden')}>
          {tree && project ? (
            <FileTree
              tree={tree}
              mainDocumentId={project.mainDocumentId}
              activeId={activeId}
              onOpen={onOpen}
            />
          ) : (
            <div
              className="grid gap-2 px-3 py-2"
              aria-busy="true"
              aria-label="Chargement des fichiers"
            >
              {[70, 55, 80, 45].map((width) => (
                <Skeleton
                  key={width}
                  className="h-4 bg-sidebar-accent"
                  style={{ width: `${String(width)}%` }}
                />
              ))}
            </div>
          )}
        </TabsContent>
        <TabsContent value="chats" className={cn('min-h-0', search !== null && 'hidden')}>
          <ChatsPanel />
        </TabsContent>
      </Tabs>

      <OutlineSection>{outline}</OutlineSection>
      <SidebarFooter user={user} workspaceId={project?.workspaceId ?? null} />
    </aside>
  )
}
