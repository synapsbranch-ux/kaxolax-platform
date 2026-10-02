'use client'

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
import { ChevronsUpDownIcon, SettingsIcon } from 'lucide-react'
import { useRouter } from 'next/navigation'
import { useEffect, useState } from 'react'
import { AccountMenu } from '@/components/billing/account-menu'
import { useSettings } from '@/components/preferences/settings-provider'
import { ThemeToggle } from '@/components/preferences/theme-toggle'
import { api, type User, type Workspace } from '@/lib/api'

/**
 * Sélecteur de workspace (pied de sidebar, barre du tableau de bord sur écran étroit) : workspace
 * courant, liste des workspaces, et lien vers le tableau de bord filtré.
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

  const current = workspaces.find((workspace) => workspace.id === workspaceId)
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
        <span className="truncate">{current?.name ?? allLabel}</span>
        <ChevronsUpDownIcon className="size-3 shrink-0" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" side={side} className="w-56">
        <DropdownMenuLabel>Workspaces</DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={workspaceId ?? ''}
          onValueChange={(id) => {
            router.push(`/dashboard?workspace=${encodeURIComponent(id)}`)
          }}
        >
          {workspaces.map((workspace) => (
            <DropdownMenuRadioItem key={workspace.id} value={workspace.id}>
              <span className="truncate">{workspace.name}</span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onSelect={() => {
            router.push('/dashboard')
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
