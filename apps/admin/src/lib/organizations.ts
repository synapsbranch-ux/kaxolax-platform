import type { AdminOrganizationSummary, WorkspaceRole } from '@kaxolax/contracts'
import { formatDateTime } from './format'

/** Organisations (workspaces d'équipe) dans l'admin : libellés de lecture seule. */

/** Libellé d'un plan Clerk (slug). */
export function planName(slug: string): string {
  if (slug === 'free') return 'Free'
  if (slug === 'pro') return 'Pro'
  if (slug === 'team') return 'Team'
  return slug
}

/** Plan et état de l'abonnement d'une organisation (« Team · actif jusqu'au … »). */
export function organizationPlanText(
  organization: Pick<AdminOrganizationSummary, 'planSlug' | 'subscriptionStatus' | 'periodEnd'>,
): string {
  const plan = planName(organization.planSlug)
  switch (organization.subscriptionStatus) {
    case null:
      return plan
    case 'active':
      return organization.periodEnd === null
        ? `${plan} · actif`
        : `${plan} · actif, renouvelé le ${formatDateTime(organization.periodEnd)}`
    case 'past_due':
      return `${plan} · paiement en retard`
    case 'canceled':
      return organization.periodEnd === null
        ? `${plan} · annulé`
        : `${plan} · annulé, actif jusqu’au ${formatDateTime(organization.periodEnd)}`
    default:
      return `${plan} · ${organization.subscriptionStatus}`
  }
}

export const WORKSPACE_ROLE_NAMES: Record<WorkspaceRole, string> = {
  owner: 'Propriétaire',
  admin: 'Administrateur',
  member: 'Membre',
}

/** Membres d'une organisation (« 3 membres, dont 1 administrateur »). */
export function seatsSummary(
  organization: Pick<AdminOrganizationSummary, 'memberCount' | 'adminCount'>,
): string {
  const { memberCount, adminCount } = organization
  const members = `${String(memberCount)} membre${memberCount > 1 ? 's' : ''}`
  if (adminCount === 0) return members
  return `${members}, dont ${String(adminCount)} administrateur${adminCount > 1 ? 's' : ''}`
}

/** État d'un projet de l'organisation (actif, archivé, à la corbeille). */
export function projectStateText(project: {
  archivedAt: string | null
  trashedAt: string | null
}): string {
  if (project.trashedAt !== null) return 'Corbeille'
  if (project.archivedAt !== null) return 'Archivé'
  return 'Actif'
}
