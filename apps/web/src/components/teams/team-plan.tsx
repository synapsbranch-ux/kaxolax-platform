'use client'

import type { Workspace, WorkspacePlanResponse } from '@kaxolax/contracts'
import { Alert, Badge, Button, cn } from '@kaxolax/ui'
import { SettingsIcon, SparklesIcon, UsersIcon } from 'lucide-react'
import Link from 'next/link'
import { useEffect, useState } from 'react'
import { UsageRows, UsageSkeleton } from '@/components/billing/plan-usage'
import { api, errorMessage } from '@/lib/api'
import { seatsText, teamPlanView, teamUrl, WORKSPACE_ROLE_LABELS } from '@/lib/teams'

/** Plan et usage d'une équipe (`GET /workspaces/:id/plan`), relus quand le workspace change. */
export function useWorkspacePlan(workspaceId: string | null): {
  plan: WorkspacePlanResponse | null
  error: string | null
} {
  const [state, setState] = useState<{
    id: string | null
    plan: WorkspacePlanResponse | null
    error: string | null
  }>({ id: null, plan: null, error: null })
  useEffect(() => {
    if (workspaceId === null) return
    let active = true
    api.workspacePlan(workspaceId).then(
      (plan) => {
        if (active) setState({ id: workspaceId, plan, error: null })
      },
      (caught: unknown) => {
        if (active) setState({ id: workspaceId, plan: null, error: errorMessage(caught) })
      },
    )
    return () => {
      active = false
    }
  }, [workspaceId])
  // Réponse d'un autre workspace (changement en cours) : rien à montrer encore.
  return state.id === workspaceId ? state : { plan: null, error: null }
}

/** Badge du plan d'une équipe (Team mis en avant). */
export function TeamPlanBadge({
  plan,
  className,
}: {
  plan: WorkspacePlanResponse | null
  className?: string
}) {
  if (plan === null) return null
  const view = teamPlanView(plan)
  return (
    <Badge
      variant={view.paid ? 'default' : 'secondary'}
      className={className}
      data-testid="team-plan-badge"
    >
      Plan {view.plan}
    </Badge>
  )
}

/**
 * Plan et usage d'une équipe (page de l'équipe) : sièges, stockage mutualisé, limites et crédits
 * du mois, état de l'abonnement d'organisation, lien vers les tarifs. Affichage seulement : les
 * limites sont appliquées par l'API.
 */
export function TeamPlanCard({
  plan,
  error,
  className,
}: {
  plan: WorkspacePlanResponse | null
  error: string | null
  className?: string
}) {
  const view = plan === null ? null : teamPlanView(plan)
  return (
    <section
      className={cn('flex flex-col gap-4 text-sm', className)}
      aria-label="Plan et usage de l’équipe"
      data-testid="team-plan"
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-muted-foreground">Plan de l’équipe</span>
        <TeamPlanBadge plan={plan} />
        {view?.subscription ? (
          <span className="text-muted-foreground">{view.subscription}</span>
        ) : null}
      </div>
      {error !== null ? (
        <Alert variant="destructive">Plan et usage indisponibles : {error}</Alert>
      ) : view === null ? (
        <UsageSkeleton />
      ) : (
        <UsageRows rows={view.rows} />
      )}
      {view?.inactiveNotice ? (
        <Alert variant="warning" data-testid="team-plan-inactive">
          {view.inactiveNotice}
        </Alert>
      ) : null}
      {view?.storageFull === true ? (
        <Alert variant="warning">
          Stockage de l’équipe plein : libérez de la place dans ses projets ou passez au plan Team
          pour ajouter du contenu.
        </Alert>
      ) : null}
      {view !== null && !view.paid ? (
        <div>
          <Button asChild size="sm">
            <Link href="/pricing#team">
              <SparklesIcon />
              Passer au plan Team
            </Link>
          </Button>
        </div>
      ) : null}
    </section>
  )
}

/**
 * Bandeau d'une équipe au-dessus de ses projets (tableau de bord filtré) : rôle, sièges, badge du
 * plan, stockage mutualisé (jauge) et lien vers la page de l'équipe.
 */
export function TeamSummary({ workspace }: { workspace: Workspace }) {
  const { plan, error } = useWorkspacePlan(workspace.id)
  const view = plan === null ? null : teamPlanView(plan)
  const storage = view?.storage
  return (
    <section
      aria-label={`Équipe ${workspace.name}`}
      className="mb-4 flex flex-col gap-3 rounded-lg border bg-card p-4 text-sm sm:flex-row sm:items-center"
      data-testid="team-summary"
    >
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <div className="flex flex-wrap items-center gap-2">
          <UsersIcon className="size-4 text-muted-foreground" aria-hidden />
          <span className="font-medium">{seatsText(workspace.memberCount)}</span>
          <span className="text-muted-foreground">
            · vous êtes {WORKSPACE_ROLE_LABELS[workspace.role].toLowerCase()}
          </span>
          <TeamPlanBadge plan={plan} />
        </div>
        {error !== null ? (
          <p className="text-destructive">Plan indisponible : {error}</p>
        ) : storage ? (
          <div className="flex items-center gap-2">
            <span className="shrink-0 text-muted-foreground">Stockage mutualisé</span>
            <span
              role="meter"
              aria-label="Stockage de l’équipe utilisé"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round((storage.ratio ?? 0) * 100)}
              className="h-2 w-full max-w-48 overflow-hidden rounded-full bg-muted"
            >
              <span
                className={cn(
                  'block h-full rounded-full',
                  (storage.ratio ?? 0) >= 1 ? 'bg-destructive' : 'bg-primary',
                )}
                style={{ width: `${String(Math.round((storage.ratio ?? 0) * 100))}%` }}
              />
            </span>
            <span className="truncate text-muted-foreground">{storage.value}</span>
          </div>
        ) : null}
      </div>
      {workspace.clerkOrganizationId !== null ? (
        <Button asChild variant="outline" size="sm">
          <Link href={teamUrl(workspace.clerkOrganizationId)} data-testid="manage-team">
            <SettingsIcon />
            Gérer l’équipe
          </Link>
        </Button>
      ) : null}
    </section>
  )
}
