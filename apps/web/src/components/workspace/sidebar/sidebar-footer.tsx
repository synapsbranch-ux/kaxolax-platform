'use client'

import { useClerk } from '@clerk/nextjs'
import { PERSONAL_WORKSPACE_NAME } from '@kaxolax/contracts'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  PresenceAvatar,
  SimpleTooltip,
  Button,
  cn,
} from '@kaxolax/ui'
import { ChevronsUpDownIcon, PlusIcon, SettingsIcon, UsersIcon } from 'lucide-react'
import { useRouter } from 'next/navigation'
import { useEffect, useState } from 'react'
import { AccountMenu } from '@/components/billing/account-menu'
import { useSettings } from '@/components/preferences/settings-provider'
import { ThemeToggle } from '@/components/preferences/theme-toggle'
import { api, type User, type Workspace } from '@/lib/api'
import {
  CREATE_TEAM_URL,
  dashboardUrl,
  isTeamWorkspace,
  splitWorkspaces,
  teamUrl,
  workspaceLabel,
} from '@/lib/teams'

/**
 * Sélecteur de workspace (pied de sidebar, barre du tableau de bord sur écran étroit) : workspace
 * personnel et équipes (`GET /workspaces`), tableau de bord filtré sur le workspace choisi, et
 * organisation active de Clerk alignée (`setActive` : aucune pour le personnel), pour que le jeton
 * de session porte le plan de l'équipe. Liens vers la création d'une équipe et la page de
 * l'équipe courante.
 */
export function WorkspaceSwitcher({
  workspaceId,
  allLabel = PERSONAL_WORKSPACE_NAME,
  side = 'top',
  className,
}: {
  /** Workspace du projet ouvert, ou filtre du tableau de bord (null : tous). */
  workspaceId: string | null
  /** Libellé affiché sans workspace choisi. */
  allLabel?: string
  /** Côté d'ouverture du menu (au-dessus dans le pied de sidebar). */
  side?: 'top' | 'bottom'
  className?: string
}) {
  const router = useRouter()
  const { setActive } = useClerk()
  const [workspaces, setWorkspaces] = useState<Workspace[]>([])

  useEffect(() => {
    let active = true
    api.workspaces().then(
      ({ workspaces: loaded }) => {
        if (active) setWorkspaces(loaded)
      },
      () => undefined,
    )
    return () => {
      active = false
    }
  }, [])

  const { personal, teams } = splitWorkspaces(workspaces)
  const current = workspaces.find((workspace) => workspace.id === workspaceId)
  const select = (id: string) => {
    const target = workspaces.find((workspace) => workspace.id === id)
    if (target === undefined) return
    // Organisation active de la session : celle de l'équipe, aucune pour le personnel. Un échec
    // (organisation quittée entre-temps) n'empêche pas d'afficher le tableau de bord.
    void setActive({ organization: target.clerkOrganizationId }).catch(() => undefined)
    router.push(dashboardUrl(target.id))
  }
  const item = (workspace: Workspace) => (
    <DropdownMenuRadioItem
      key={workspace.id}
      value={workspace.id}
      data-testid="workspace-option"
      data-workspace-type={workspace.type}
    >
      <span className="truncate">{workspaceLabel(workspace)}</span>
    </DropdownMenuRadioItem>
  )
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className={cn(
          'flex max-w-full items-center gap-1 rounded-sm text-xs text-sidebar-muted-foreground outline-none hover:text-sidebar-foreground focus-visible:ring-[3px] focus-visible:ring-sidebar-ring/50',
          className,
        )}
        aria-label="Changer de workspace"
        data-testid="workspace-switcher"
      >
        {current !== undefined && isTeamWorkspace(current) ? (
          <UsersIcon className="size-3 shrink-0" aria-hidden />
        ) : null}
        <span className="truncate">
          {current === undefined ? allLabel : workspaceLabel(current)}
        </span>
        <ChevronsUpDownIcon className="size-3 shrink-0" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" side={side} className="w-60">
        <DropdownMenuRadioGroup
          value={workspaceId ?? ''}
          onValueChange={(id) => {
            select(id)
          }}
        >
          <DropdownMenuLabel>Workspace personnel</DropdownMenuLabel>
          {personal ? item(personal) : null}
          <DropdownMenuSeparator />
          <DropdownMenuLabel>Équipes</DropdownMenuLabel>
          {teams.map(item)}
        </DropdownMenuRadioGroup>
        {teams.length === 0 ? (
          <p className="px-2 py-1 text-xs text-muted-foreground">Aucune équipe pour l’instant.</p>
        ) : null}
        <DropdownMenuItem
          onSelect={() => {
            router.push(CREATE_TEAM_URL)
          }}
          data-testid="create-team"
        >
          <PlusIcon /> Créer une équipe
        </DropdownMenuItem>
        {current?.clerkOrganizationId ? (
          <DropdownMenuItem
            onSelect={() => {
              if (current.clerkOrganizationId) router.push(teamUrl(current.clerkOrganizationId))
            }}
            data-testid="open-team"
          >
            <SettingsIcon /> Gérer l’équipe
          </DropdownMenuItem>
        ) : null}
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onSelect={() => {
            router.push(dashboardUrl(null))
          }}
        >
          Tous les projets
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/**
 * Pied de la sidebar : avatar et nom de l'utilisateur, workspace courant (celui du projet) avec
 * son sélecteur (vers le tableau de bord filtré), et menu du compte Clerk (profil, sécurité,
 * facturation, déconnexion).
 */
export function SidebarFooter({
  user,
  workspaceId,
  allLabel,
}: {
  user: User | null
  /** Workspace du projet ouvert, ou filtre du tableau de bord (null : tous). */
  workspaceId: string | null
  /** Libellé affiché sans workspace choisi. */
  allLabel?: string
}) {
  const name = user?.fullName ?? user?.email ?? ''
  const { openSettings } = useSettings()

  return (
    <footer className="flex h-sidebar-footer shrink-0 items-center gap-2 border-t border-sidebar-border px-2">
      <PresenceAvatar name={name} imageUrl={user?.avatarUrl} size="default" />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium leading-tight" title={user?.email}>
          {name}
        </p>
        <WorkspaceSwitcher workspaceId={workspaceId} allLabel={allLabel} />
      </div>
      <ThemeToggle />
      <SimpleTooltip label="Paramètres de l’éditeur">
        <Button
          variant="ghost"
          size="icon-sm"
          className="shrink-0 text-sidebar-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
          aria-label="Paramètres de l’éditeur"
          data-testid="open-settings"
          onClick={() => {
            openSettings()
          }}
        >
          <SettingsIcon />
        </Button>
      </SimpleTooltip>
      {/* Compte : profil, sécurité (MFA, sessions), facturation (pages de /account), tarifs,
          paramètres de l'éditeur, déconnexion. */}
      <AccountMenu
        onOpenSettings={() => {
          openSettings()
        }}
      />
    </footer>
  )
}
