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
import type { PresenceUser, ProjectSearchMatch } from '@kaxolax/contracts'
import type { ReactNode } from 'react'
import { unreadBadge } from '@/lib/chat'
import type { Project, ProjectTree, User } from '@/lib/api'
import type { OnlinePerson } from '@/lib/presence'
import { useFileActions } from '../file-actions'
import type { ProjectChat } from '../use-project-chat'
import { ChatsPanel } from './chats-panel'
import { FileTree } from './file-tree'
import { OutlineSection } from './outline-section'
import { PresenceStack } from './presence-stack'
import { ProjectSearch } from './project-search'
import { ProjectSwitcher } from './project-switcher'
import { ShareButton } from './share-dialog'
import { SidebarFooter } from './sidebar-footer'

/** Onglets de la sidebar. */
export type SidebarTab = 'files' | 'chats'

const iconButton =
  'text-sidebar-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground'

/**
 * Colonne de gauche : logo et repli, sélecteur de projet, présence et invitation, onglets Fichiers et
 * Chats (recherche dans le projet, menu +), plan du document et pied (utilisateur, workspace,
 * compte). Présence : avatars des personnes en ligne (clic : suivre) et pastilles des fichiers
 * ouverts par d'autres ; le bouton d'invitation ouvre la modale de partage.
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
  people,
  presenceByDocument,
  nameOf,
  onFollow,
  membersVersion,
  onAccessChanged,
  onOpenLocation,
  tab,
  onTabChange,
  chat,
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
  /** Autres personnes en ligne (document meta du projet). */
  people: readonly OnlinePerson[]
  /** Personnes qui ont chaque fichier ouvert. */
  presenceByDocument: ReadonlyMap<string, readonly PresenceUser[]>
  /** Nom d'un fichier du projet par son id. */
  nameOf: (id: string) => string | null
  /** Clic sur un avatar : suivre ce collaborateur. */
  onFollow: (person: OnlinePerson) => void
  /** Incrémenté à chaque événement de membre (modale de partage ouverte relue). */
  membersVersion: number
  /** Son propre rôle a changé depuis la modale de partage. */
  onAccessChanged: () => void
  /** Ouvre un document à une ligne (références `fichier.tex:42` du chat). */
  onOpenLocation?: (path: string, line: number) => void
  /** Onglet courant, gardé par la page : le tiroir d'un écran étroit se démonte à la fermeture. */
  tab: SidebarTab
  onTabChange: (tab: SidebarTab) => void
  /** Chat du projet, tenu par la page : non-lus suivis même sidebar repliée ou tiroir fermé. */
  chat: ProjectChat
}) {
  const files = useFileActions()
  const badge = unreadBadge(chat.unread)

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
        <PresenceStack people={people} nameOf={nameOf} onFollow={onFollow} />
        <ShareButton
          project={project}
          user={user}
          membersVersion={membersVersion}
          onAccessChanged={onAccessChanged}
        />
      </div>

      <Tabs
        value={tab}
        onValueChange={(value) => {
          onTabChange(value === 'chats' ? 'chats' : 'files')
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
              {badge !== null ? (
                <span
                  className="ml-1 min-w-4 rounded-full bg-sidebar-primary px-1 text-center text-[0.625rem] leading-4 font-semibold text-sidebar-primary-foreground tabular-nums"
                  aria-label={`${badge} ${chat.unread > 1 ? 'messages non lus' : 'message non lu'}`}
                  data-testid="chat-unread-badge"
                >
                  {badge}
                </span>
              ) : null}
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
              presence={presenceByDocument}
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
          {project ? (
            <ChatsPanel
              projectId={project.id}
              tree={tree}
              selfId={user?.id ?? null}
              chat={chat}
              membersVersion={membersVersion}
              onOpenLocation={onOpenLocation}
            />
          ) : null}
        </TabsContent>
      </Tabs>

      <OutlineSection>{outline}</OutlineSection>
      <SidebarFooter user={user} workspaceId={project?.workspaceId ?? null} />
    </aside>
  )
}
