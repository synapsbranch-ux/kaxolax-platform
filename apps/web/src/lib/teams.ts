import {
  hasWorkspacePermission,
  type ProjectRole,
  type TeamMemberRole,
  type Workspace,
  type WorkspacePlanResponse,
  type WorkspaceRole,
} from '@kaxolax/contracts'
import { formatBytes, formatSeconds, planLabel } from './plan-limits'
import { creditRow, type PlanUsageRow, subscriptionLabel } from './plan-usage'

/**
 * Workspaces d'équipe (Organisations Clerk) côté interface : adresses, libellés, cibles d'un
 * déplacement, plan et usage de l'équipe. Les droits sont appliqués par l'API ; rien n'est
 * décidé ici, l'interface ne fait que montrer les actions permises.
 */

/** Création d'une équipe (`<CreateOrganization />`). */
export const CREATE_TEAM_URL = '/team/new'

/** Page d'une équipe (`<OrganizationProfile />` : membres, invitations, rôles, facturation). */
export function teamUrl(clerkOrganizationId: string): string {
  return `/team/${encodeURIComponent(clerkOrganizationId)}`
}

/** Tableau de bord filtré sur un workspace (null : tous les projets). */
export function dashboardUrl(workspaceId: string | null): string {
  return workspaceId === null
    ? '/dashboard'
    : `/dashboard?workspace=${encodeURIComponent(workspaceId)}`
}

/** Libellés des rôles de workspace (rôles Clerk `org:admin` et `org:member` pour une équipe). */
export const WORKSPACE_ROLE_LABELS: Record<WorkspaceRole, string> = {
  owner: 'Propriétaire',
  admin: 'Administrateur',
  member: 'Membre',
}

export function isTeamWorkspace(workspace: Workspace): boolean {
  return workspace.type === 'team' && workspace.clerkOrganizationId !== null
}

/** Nom affiché d'un workspace : « Personnel » (nom technique en anglais), ou celui de l'équipe. */
export function workspaceLabel(workspace: Pick<Workspace, 'type' | 'name'>): string {
  return workspace.type === 'personal' ? 'Personnel' : workspace.name
}

/** Workspace personnel et équipes (par nom), pour le sélecteur. */
export function splitWorkspaces(workspaces: readonly Workspace[]): {
  personal: Workspace | null
  teams: Workspace[]
} {
  return {
    personal: workspaces.find((workspace) => workspace.type === 'personal') ?? null,
    teams: workspaces
      .filter(isTeamWorkspace)
      .sort((a, b) => a.name.localeCompare(b.name, 'fr', { sensitivity: 'base' })),
  }
}

/** Nombre de membres lisible (« 1 membre », « 3 membres »). */
export function seatsText(count: number): string {
  return `${count.toLocaleString('fr-FR')} membre${count > 1 ? 's' : ''}`
}

/** Équipe d'un projet (son workspace s'il est d'équipe), sinon null. */
export function teamOfProject(
  project: { workspaceId: string },
  workspaces: readonly Workspace[],
): Workspace | null {
  const workspace = workspaces.find((candidate) => candidate.id === project.workspaceId)
  return workspace !== undefined && isTeamWorkspace(workspace) ? workspace : null
}

/**
 * Équipes vers lesquelles un projet peut être déplacé : seulement un projet personnel dont
 * l'utilisateur est propriétaire, vers une équipe où son rôle permet de créer des projets.
 */
export function moveTargets(
  project: { workspaceId: string; role: ProjectRole },
  workspaces: readonly Workspace[],
): Workspace[] {
  if (project.role !== 'owner') return []
  const current = workspaces.find((workspace) => workspace.id === project.workspaceId)
  if (current?.type !== 'personal') return []
  return splitWorkspaces(workspaces).teams.filter((workspace) =>
    hasWorkspacePermission(workspace.role, 'createProject'),
  )
}

/** Libellés des rôles d'équipe sur un projet (rôle des membres `member`). */
export const TEAM_ROLE_LABELS: Record<TeamMemberRole, string> = {
  editor: 'Éditeur',
  reviewer: 'Relecteur',
  viewer: 'Lecteur',
}

/** Phrase de l'accès d'équipe d'un projet (modale de partage). */
export function teamAccessText(team: {
  name: string
  memberRole: TeamMemberRole
  memberCount: number
}): string {
  return `Les ${seatsText(team.memberCount)} de l’équipe « ${team.name} » y ont accès : administrateurs comme propriétaires, membres comme ${TEAM_ROLE_LABELS[team.memberRole].toLowerCase()}s.`
}

/** Refus d'ajouter un projet à une équipe sans plan actif (`E_TEAM_PLAN_REQUIRED`). */
export const TEAM_PLAN_REQUIRED_MESSAGE =
  'Cette équipe n’a pas de plan actif : passez au plan Team pour y créer, importer ou déplacer des projets.'

/** Message français d'une erreur liée aux équipes (plan requis), sinon `fallback`. */
export function teamErrorMessage(error: unknown, fallback: (error: unknown) => string): string {
  if (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'E_TEAM_PLAN_REQUIRED'
  ) {
    return TEAM_PLAN_REQUIRED_MESSAGE
  }
  return fallback(error)
}

export interface TeamPlanView {
  plan: string
  /** Plan d'équipe payant actif : badge mis en avant, projets et réserve de crédits. */
  paid: boolean
  /** Sans plan actif : ce qui manque à l'équipe (null avec un plan actif). */
  inactiveNotice: string | null
  rows: PlanUsageRow[]
  /** Ligne du stockage mutualisé (aussi dans `rows`), pour le bandeau du tableau de bord. */
  storage: PlanUsageRow
  subscription: string | null
  storageFull: boolean
}

/**
 * Plan et usage d'une équipe pour l'affichage (`GET /workspaces/:id/plan`) : sièges, stockage
 * mutualisé (jauge), limites du plan de l'organisation, crédits du mois de la réserve d'équipe.
 */
export function teamPlanView(plan: WorkspacePlanResponse): TeamPlanView {
  const { limits, usage } = plan
  const ratio =
    limits.storageBytes === 0 ? 1 : Math.min(1, usage.storageBytes / limits.storageBytes)
  const perSeat = (monthly: number) =>
    plan.perSeat && plan.seats > 0
      ? ` (${Math.round(monthly / plan.seats).toLocaleString('fr-FR')} par membre)`
      : ''
  const storage: PlanUsageRow = {
    label: 'Stockage mutualisé',
    value: `${formatBytes(usage.storageBytes)} sur ${formatBytes(limits.storageBytes)}`,
    ratio,
  }
  // Sans plan actif, pas de réserve d'équipe : l'IA est décomptée des crédits de chacun.
  const noPool = 'Pas de réserve d’équipe : crédits personnels de chacun'
  const ai = plan.active
    ? creditRow('Crédits IA', plan.credits.ai, plan.credits.resetsAt)
    : { label: 'Crédits IA', value: noPool }
  const images = plan.active
    ? creditRow('Images', plan.credits.images, plan.credits.resetsAt)
    : { label: 'Images', value: noPool }
  return {
    plan: planLabel(plan.plan),
    paid: plan.active,
    inactiveNotice: plan.active
      ? null
      : 'Sans plan actif, l’équipe n’accepte pas de nouveaux projets et n’a pas de réserve de crédits IA.',
    rows: [
      {
        label: 'Sièges',
        value: plan.perSeat
          ? `${seatsText(plan.seats)}, facturés par siège`
          : seatsText(plan.seats),
      },
      storage,
      {
        label: 'Durée de compilation',
        value: `${formatSeconds(limits.maxCompileSeconds)} au plus par compilation`,
      },
      {
        label: 'Invités par projet',
        value:
          limits.maxCollaborators === null
            ? 'Illimités (les membres de l’équipe ne comptent pas)'
            : `${String(limits.maxCollaborators)} (les membres de l’équipe ne comptent pas)`,
      },
      {
        label: 'Historique',
        value:
          limits.historyRetentionDays === null
            ? 'Complet'
            : `${String(limits.historyRetentionDays)} jour${limits.historyRetentionDays > 1 ? 's' : ''}`,
      },
      plan.active ? { ...ai, value: `${ai.value}${perSeat(plan.credits.ai.monthly)}` } : ai,
      plan.active
        ? { ...images, value: `${images.value}${perSeat(plan.credits.images.monthly)}` }
        : images,
    ],
    storage,
    subscription: subscriptionLabel(plan.subscription),
    storageFull: usage.storageBytes >= limits.storageBytes,
  }
}
