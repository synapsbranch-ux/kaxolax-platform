'use client'

import { CreateOrganization, OrganizationProfile } from '@clerk/nextjs'
import { Alert, Button, Spinner } from '@kaxolax/ui'
import { FolderIcon } from 'lucide-react'
import Link from 'next/link'
import { dashboardUrl, seatsText, teamUrl, WORKSPACE_ROLE_LABELS } from '@/lib/teams'
import { TeamPlanBadge, TeamPlanCard, useWorkspacePlan } from './team-plan'
import { useTeamWorkspace } from './use-team-workspace'

/**
 * Création d'une équipe : `<CreateOrganization />` de Clerk (nom, logo), puis la page de la
 * nouvelle équipe, qui attend sa synchronisation et où s'envoient les invitations.
 */
export function CreateTeam() {
  return (
    <CreateOrganization
      path="/team/new"
      routing="path"
      // Les invitations s'envoient ensuite depuis la page de l'équipe (onglet Membres).
      skipInvitationScreen
      afterCreateOrganizationUrl={(organization) => teamUrl(organization.id)}
    />
  )
}

/**
 * Page d'une équipe (`/team/<org_…>`) : l'organisation devient active dans la session, puis
 * en-tête (nom, rôle, sièges, plan), lien vers ses projets, plan et usage mutualisés, et
 * `<OrganizationProfile />` de Clerk (membres, invitations, rôles, facturation de
 * l'organisation quand Billing est activé pour les organisations, départ ou suppression). Les
 * rôles d'équipe sur chaque projet se règlent dans sa fenêtre de partage.
 */
export function TeamPage({ clerkOrganizationId }: { clerkOrganizationId: string }) {
  const state = useTeamWorkspace(clerkOrganizationId)
  const workspace = state.status === 'ready' ? state.workspace : null
  const { plan, error } = useWorkspacePlan(workspace?.id ?? null)

  if (state.status === 'missing' && state.reason === 'not-member') {
    return (
      <Alert variant="destructive" className="w-full" data-testid="team-missing">
        Équipe introuvable : vous n’en êtes pas (ou plus) membre.{' '}
        <Link href="/dashboard" className="underline underline-offset-4">
          Retour au tableau de bord
        </Link>
      </Alert>
    )
  }

  return (
    <div className="flex w-full flex-col items-center gap-6">
      <header className="flex w-full flex-col gap-3 sm:flex-row sm:items-end">
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <h1 className="truncate text-2xl font-semibold tracking-tight" data-testid="team-name">
            {workspace?.name ?? 'Équipe'}
          </h1>
          {workspace ? (
            <p className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
              <span>{seatsText(workspace.memberCount)}</span>
              <span aria-hidden>·</span>
              <span data-testid="team-role">
                Vous êtes {WORKSPACE_ROLE_LABELS[workspace.role].toLowerCase()}
              </span>
              <TeamPlanBadge plan={plan} />
            </p>
          ) : (
            <p
              className="flex items-center gap-2 text-sm text-muted-foreground"
              aria-busy="true"
              data-testid="team-syncing"
            >
              <Spinner label="" />
              {state.status === 'syncing'
                ? 'Synchronisation de l’équipe…'
                : 'Chargement de l’équipe…'}
            </p>
          )}
        </div>
        {workspace ? (
          <Button asChild>
            <Link href={dashboardUrl(workspace.id)} data-testid="team-projects">
              <FolderIcon />
              Projets de l’équipe
            </Link>
          </Button>
        ) : null}
      </header>

      {state.status === 'missing' ? (
        <Alert variant="warning" className="w-full">
          L’équipe n’est pas encore synchronisée avec Kaxolax. Réessayez dans quelques instants ;
          ses membres et sa facturation se gèrent déjà ci-dessous.
        </Alert>
      ) : null}

      {workspace ? (
        <TeamPlanCard plan={plan} error={error} className="w-full rounded-lg border p-4" />
      ) : null}

      {state.status !== 'loading' ? (
        <OrganizationProfile
          path={teamUrl(clerkOrganizationId)}
          routing="path"
          afterLeaveOrganizationUrl="/dashboard"
        />
      ) : null}
    </div>
  )
}
