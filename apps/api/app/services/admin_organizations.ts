import {
  ADMIN_MAX_PAGE_SIZE,
  type AdminOrganizationResponse,
  type AdminOrganizationsResponse,
  type AdminOrganizationSummary,
  FREE_PLAN,
  type WorkspaceRole,
} from '@kaxolax/contracts'
import { Exception } from '@adonisjs/core/exceptions'
import db from '@adonisjs/lucid/services/db'
import { DateTime } from 'luxon'
import ClerkOrganization from '#models/clerk_organization'
import { likePattern, paginationOf } from '#services/admin_users'
import { isoString, isoStringOrNull } from '#services/dates'
import { CURRENT_SUBSCRIPTION_STATUSES } from '#services/plans'

/**
 * Admin : organisations Clerk reflétées (workspaces d'équipe) avec leur plan d'organisation
 * (miroir des abonnements), leurs sièges, projets et stockage. Lecture seule : les équipes se
 * gèrent dans le Dashboard Clerk.
 */

interface WorkspaceStats {
  workspace_id: string
  clerk_organization_id: string
  owner_id: string
  owner_email: string
  owner_full_name: string | null
  member_count: number
  admin_count: number
  project_count: number
  storage_bytes: string | number
}

interface CurrentSubscription {
  clerk_organization_id: string
  plan_slug: string
  status: string
  period_end: Date | null
}

/** Statistiques des workspaces d'équipe des organisations données. */
async function workspaceStats(organizationIds: string[]): Promise<Map<string, WorkspaceStats>> {
  if (organizationIds.length === 0) return new Map()
  const result = await db.rawQuery<{ rows: WorkspaceStats[] }>(
    `SELECT w.id AS workspace_id, w.clerk_organization_id, w.owner_id,
            u.email AS owner_email, u.full_name AS owner_full_name,
            (SELECT COUNT(*)::int FROM workspace_members m WHERE m.workspace_id = w.id)
              AS member_count,
            (SELECT COUNT(*)::int FROM workspace_members m
              WHERE m.workspace_id = w.id AND m.role IN ('owner', 'admin')) AS admin_count,
            (SELECT COUNT(*)::int FROM projects p WHERE p.workspace_id = w.id) AS project_count,
            (SELECT COALESCE(SUM(f.size_bytes), 0) FROM files f
               JOIN projects p ON p.id = f.project_id WHERE p.workspace_id = w.id)
            + (SELECT COALESCE(SUM(octet_length(d.yjs_state)), 0) FROM documents d
               JOIN projects p ON p.id = d.project_id WHERE p.workspace_id = w.id)
              AS storage_bytes
       FROM workspaces w JOIN users u ON u.id = w.owner_id
      WHERE w.type = 'team' AND w.clerk_organization_id = ANY(?::text[])`,
    [organizationIds],
  )
  return new Map(result.rows.map((row) => [row.clerk_organization_id, row]))
}

/** Abonnement en cours de chaque organisation (payant d'abord, puis le plus récent). */
async function currentSubscriptions(
  organizationIds: string[],
): Promise<Map<string, CurrentSubscription>> {
  if (organizationIds.length === 0) return new Map()
  const rows = (await db
    .from('subscriptions')
    .whereIn('clerk_organization_id', organizationIds)
    .whereIn('status', CURRENT_SUBSCRIPTION_STATUSES)
    .orderByRaw('(plan_slug = ?) ASC, updated_at DESC', [FREE_PLAN])
    .select('clerk_organization_id', 'plan_slug', 'status', 'period_end')) as CurrentSubscription[]
  const current = new Map<string, CurrentSubscription>()
  for (const row of rows) {
    if (!current.has(row.clerk_organization_id)) current.set(row.clerk_organization_id, row)
  }
  return current
}

/**
 * Recherche par nom ou slug (sous-chaîne, sans casse), ou par identifiant Clerk exact (`org_…`) ;
 * organisations supprimées comprises, les plus récentes d'abord.
 */
export async function searchOrganizations(filters: {
  q?: string | undefined
  page: number
  perPage: number
}): Promise<AdminOrganizationsResponse> {
  const term = filters.q?.trim() ?? ''
  const query = ClerkOrganization.query()
    .orderBy('created_at', 'desc')
    .orderBy('clerk_organization_id', 'asc')
  if (term !== '') {
    const pattern = likePattern(term)
    void query.where((search) => {
      void search
        .whereILike('name', pattern)
        .orWhereILike('slug', pattern)
        .orWhere('clerk_organization_id', term)
    })
  }
  const page = await query.paginate(filters.page, filters.perPage)
  const organizations = page.all()
  const ids = organizations.map((organization) => organization.clerkOrganizationId)
  const stats = await workspaceStats(ids)
  const subscriptions = await currentSubscriptions(ids)
  return {
    organizations: organizations.map((organization) =>
      serializeOrganization(
        organization,
        stats.get(organization.clerkOrganizationId),
        subscriptions.get(organization.clerkOrganizationId),
      ),
    ),
    pagination: paginationOf(page),
  }
}

function serializeOrganization(
  organization: ClerkOrganization,
  stats: WorkspaceStats | undefined,
  subscription: CurrentSubscription | undefined,
): AdminOrganizationSummary {
  return {
    workspaceId: stats?.workspace_id ?? null,
    clerkOrganizationId: organization.clerkOrganizationId,
    name: organization.name,
    slug: organization.slug,
    planSlug: subscription?.plan_slug ?? FREE_PLAN,
    subscriptionStatus: subscription?.status ?? null,
    periodEnd: subscription?.period_end
      ? isoString(DateTime.fromJSDate(subscription.period_end))
      : null,
    memberCount: stats?.member_count ?? 0,
    adminCount: stats?.admin_count ?? 0,
    projectCount: stats?.project_count ?? 0,
    storageBytes: Number(stats?.storage_bytes ?? 0),
    owner: stats
      ? { id: stats.owner_id, email: stats.owner_email, fullName: stats.owner_full_name }
      : null,
    createdAt: isoString(organization.createdAt),
    deletedAt: isoStringOrNull(organization.deletedAt),
  }
}

export class AdminOrganizationNotFoundException extends Exception {
  static override status = 404
  static override code = 'E_ORGANIZATION_NOT_FOUND'
  static override message = 'Organization not found'
}

interface MemberRow {
  user_id: string
  email: string
  full_name: string | null
  role: WorkspaceRole
  created_at: Date
}

interface ProjectRow {
  id: string
  name: string
  owner_id: string
  owner_email: string
  owner_full_name: string | null
  archived_at: Date | null
  trashed_at: Date | null
  updated_at: Date
}

const dateOf = (value: Date) => isoString(DateTime.fromJSDate(value))
const dateOrNull = (value: Date | null) => (value === null ? null : dateOf(value))

/**
 * Fiche d'une organisation (`GET /admin/organizations/:id`, identifiant Clerk) : résumé, membres
 * (administrateurs d'abord, puis par arrivée) et projets du workspace d'équipe (les plus récents,
 * au plus `ADMIN_MAX_PAGE_SIZE`, métadonnées seulement). Lecture seule.
 */
export async function organizationDetail(
  clerkOrganizationId: string,
): Promise<AdminOrganizationResponse> {
  const organization = await ClerkOrganization.query()
    .where('clerk_organization_id', clerkOrganizationId)
    .first()
  if (!organization) throw new AdminOrganizationNotFoundException()
  const ids = [clerkOrganizationId]
  const stats = (await workspaceStats(ids)).get(clerkOrganizationId)
  const summary = serializeOrganization(
    organization,
    stats,
    (await currentSubscriptions(ids)).get(clerkOrganizationId),
  )
  if (!stats) return { organization: summary, members: [], projects: [], projectTotal: 0 }
  const workspaceId = stats.workspace_id
  const members = (await db
    .from('workspace_members as m')
    .join('users as u', 'u.id', 'm.user_id')
    .where('m.workspace_id', workspaceId)
    .orderByRaw("(m.role IN ('owner', 'admin')) DESC, m.created_at ASC, u.id ASC")
    .select('u.id as user_id', 'u.email', 'u.full_name', 'm.role', 'm.created_at')) as MemberRow[]
  const projects = (await db
    .from('projects as p')
    .join('users as o', 'o.id', 'p.owner_id')
    .where('p.workspace_id', workspaceId)
    .orderBy('p.updated_at', 'desc')
    .orderBy('p.id', 'asc')
    .limit(ADMIN_MAX_PAGE_SIZE)
    .select(
      'p.id',
      'p.name',
      'p.owner_id',
      'o.email as owner_email',
      'o.full_name as owner_full_name',
      'p.archived_at',
      'p.trashed_at',
      'p.updated_at',
    )) as ProjectRow[]
  return {
    organization: summary,
    members: members.map((row) => ({
      user: { id: row.user_id, email: row.email, fullName: row.full_name },
      role: row.role,
      joinedAt: dateOf(row.created_at),
    })),
    projects: projects.map((row) => ({
      id: row.id,
      name: row.name,
      owner: { id: row.owner_id, email: row.owner_email, fullName: row.owner_full_name },
      archivedAt: dateOrNull(row.archived_at),
      trashedAt: dateOrNull(row.trashed_at),
      updatedAt: dateOf(row.updated_at),
    })),
    projectTotal: stats.project_count,
  }
}
