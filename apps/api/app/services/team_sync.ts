import { randomUUID } from 'node:crypto'
import {
  clerkDeletedObjectSchema,
  clerkOrganizationMembershipSchema,
  clerkOrganizationSchema,
  type WorkspaceRole,
  workspaceRoleFromClerk,
} from '@kaxolax/contracts'
import logger from '@adonisjs/core/services/logger'
import type { TransactionClientContract } from '@adonisjs/lucid/types/database'
import type { DateTime } from 'luxon'
import ClerkOrganization from '#models/clerk_organization'
import Project from '#models/project'
import ProjectMember from '#models/project_member'
import User from '#models/user'
import Workspace from '#models/workspace'
import { billingEventTime } from '#services/billing_webhooks'
import { transferOwnership } from '#services/project_ownership'
import {
  type DeletedProject,
  deleteProjectRows,
  type ProjectReleaseServices,
  releaseDeletedProject,
} from '#services/project_service'
import { ensurePersonalWorkspace } from '#services/workspace_service'

/**
 * Workspaces d'équipe (tâche 10) : un workspace `team` par Organisation Clerk, ses membres
 * (`workspace_members`, rôle `admin` ou `member` d'après `org:admin` / `org:member`) dérivés du
 * miroir des organisations et des adhésions.
 *
 * - Miroir : chaque événement (`organization.*`, `organizationMembership.*`, commande de
 *   rattrapage) met à jour `clerk_organizations` ou `clerk_organization_memberships` seulement s'il
 *   est plus récent que l'état connu (date de l'enveloppe Clerk) ; une suppression laisse une
 *   pierre tombale. Événements rejoués : écartés en amont (clerk_webhook_events) ; désordonnés :
 *   l'état le plus récent gagne, quel que soit l'ordre d'arrivée.
 * - Réconciliation (`reconcileOrganization`, idempotente, verrou consultatif par organisation) :
 *   le workspace et ses membres sont recalculés depuis le miroir. Une adhésion dont le compte
 *   n'est pas encore connu attend son `user.created` (`attachPendingMemberships`).
 * - Responsable (`workspaces.owner_id`, moindre privilège) : un administrateur actif (le créateur
 *   s'il est administrateur, sinon le plus ancien), sinon le plus ancien membre actif ; un compte
 *   banni seulement à défaut. Le responsable en place le reste tant qu'aucun membre n'est mieux
 *   placé (un responsable banni ou rétrogradé est remplacé).
 * - Départ d'un membre (ou compte supprimé) : ses projets du workspace passent au responsable
 *   (transfert de propriété, le projet reste dans l'équipe) et il perd l'accès d'équipe ; ses
 *   invitations individuelles à d'autres projets de l'équipe restent. Sans responsable pour les
 *   recevoir, ses projets restent dans l'équipe à son nom (journalisé) et passent au responsable
 *   à la réconciliation suivante qui en trouve un : jamais de perte silencieuse.
 * - Verrous : compte (`clerk-user:…`) avant organisation (`team:…`) ; plusieurs organisations
 *   dans l'ordre de `clerk_organization_id` (`lockTeam`). Pas d'interblocage entre webhooks,
 *   suppression de compte et rattrapage.
 * - Concurrence avec la création du compte : `user.created` (ou le guard) et un événement
 *   d'adhésion du même compte prennent le même verrou consultatif (`lockClerkUser`) avant
 *   d'écrire ; le second voit donc toujours ce que le premier a validé.
 * - Organisation supprimée : chaque projet du workspace rejoint le workspace personnel de son
 *   propriétaire (avec ses fichiers, son historique et ses membres invités), puis le workspace est
 *   supprimé. Seule exception : un projet resté au nom d'un compte supprimé (gardé faute de
 *   responsable, voir plus haut) est supprimé comme les autres projets de ce compte, jamais
 *   rattaché à un workspace personnel recréé pour lui.
 * - Invitations d'organisation (`organizationInvitation.*`) : gérées par Clerk ; l'adhésion qui
 *   suit leur acceptation arrive par `organizationMembership.created`.
 */

/** Accès changés après la transaction : chaque compte de `userIds` sur chaque projet. */
export interface TeamAccessChange {
  projectIds: string[]
  userIds: string[]
}

export interface TeamSyncEffects {
  changes: TeamAccessChange[]
  /** Projets supprimés (équipe dissoute, propriétaire supprimé) : ressources à libérer. */
  deleted: DeletedProject[]
}

export const NO_TEAM_EFFECTS: TeamSyncEffects = { changes: [], deleted: [] }

export function mergeTeamEffects(...effects: TeamSyncEffects[]): TeamSyncEffects {
  return {
    changes: effects.flatMap((effect) => effect.changes),
    deleted: effects.flatMap((effect) => effect.deleted),
  }
}

export function isOrganizationEvent(type: string): boolean {
  return (
    type.startsWith('organization.') ||
    type.startsWith('organizationMembership.') ||
    type.startsWith('organizationInvitation.')
  )
}

// --- Miroir ---------------------------------------------------------------------------------

/** Date de l'état reflété, dans la précision de PostgreSQL (microsecondes, ici millisecondes). */
function sqlTime(at: DateTime): string {
  const sql = at.toUTC().toSQL()
  if (sql === null) throw new Error('Invalid event date')
  return sql
}

/**
 * Verrou consultatif d'un compte Clerk, jusqu'à la fin de la transaction : sérialise la création
 * du compte local (`upsertClerkUser`) et l'écriture de ses adhésions dans le miroir, pour qu'une
 * adhésion ne soit jamais perdue entre deux transactions simultanées. Toujours pris avant le
 * verrou d'une organisation (`team:…`), jamais après : pas d'interblocage.
 */
export async function lockClerkUser(
  clerkUserId: string,
  trx: TransactionClientContract,
): Promise<void> {
  await trx.rawQuery('SELECT pg_advisory_xact_lock(hashtext(?))', [`clerk-user:${clerkUserId}`])
}

/**
 * Verrou consultatif d'une organisation (`team:…`), jusqu'à la fin de la transaction. Pris après
 * les verrous de comptes ; plusieurs organisations toujours dans l'ordre croissant de
 * `clerk_organization_id` (ordre d'octets, `localeCompare` exclu) pour éviter tout interblocage.
 */
export async function lockTeam(
  clerkOrganizationId: string,
  trx: TransactionClientContract,
): Promise<void> {
  await trx.rawQuery('SELECT pg_advisory_xact_lock(hashtext(?))', [`team:${clerkOrganizationId}`])
}

/** Tri par ordre d'octets (identique pour SQL `COLLATE "C"` et JavaScript). */
export function byteOrder(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

/**
 * Organisation créée ou modifiée : reflétée si l'événement est plus récent que l'état connu et
 * que l'organisation n'est pas supprimée (état définitif).
 */
export async function upsertOrganizationMirror(
  organization: { id: string; name: string; slug: string | null; createdBy: string | null },
  eventAt: DateTime,
  trx: TransactionClientContract,
): Promise<void> {
  await trx.rawQuery(
    `INSERT INTO clerk_organizations
       (clerk_organization_id, name, slug, created_by_clerk_user_id, event_at)
     VALUES (?, ?, NULLIF(?, ''), NULLIF(?, ''), ?)
     ON CONFLICT (clerk_organization_id) DO UPDATE
       SET name = EXCLUDED.name, slug = EXCLUDED.slug,
           created_by_clerk_user_id = COALESCE(EXCLUDED.created_by_clerk_user_id,
                                               clerk_organizations.created_by_clerk_user_id),
           event_at = EXCLUDED.event_at
       WHERE clerk_organizations.deleted_at IS NULL
         AND clerk_organizations.event_at <= EXCLUDED.event_at`,
    // Texte vide : NULL (les liaisons de Lucid n'acceptent pas null).
    [
      organization.id,
      organization.name,
      organization.slug ?? '',
      organization.createdBy ?? '',
      sqlTime(eventAt),
    ],
  )
}

/**
 * Organisation connue seulement par une adhésion (événement d'organisation pas encore reçu) :
 * insérée avec une date nulle (époque Unix), que tout événement d'organisation remplace.
 */
async function seedOrganizationMirror(
  organization: { id: string; name: string; slug: string | null; createdBy: string | null },
  trx: TransactionClientContract,
): Promise<void> {
  await trx.rawQuery(
    `INSERT INTO clerk_organizations
       (clerk_organization_id, name, slug, created_by_clerk_user_id, event_at)
     VALUES (?, ?, NULLIF(?, ''), NULLIF(?, ''), to_timestamp(0))
     ON CONFLICT (clerk_organization_id) DO NOTHING`,
    [organization.id, organization.name, organization.slug ?? '', organization.createdBy ?? ''],
  )
}

/** Organisation supprimée : pierre tombale définitive (même si elle n'était pas connue). */
export async function deleteOrganizationMirror(
  clerkOrganizationId: string,
  eventAt: DateTime,
  trx: TransactionClientContract,
): Promise<void> {
  await trx.rawQuery(
    `INSERT INTO clerk_organizations (clerk_organization_id, name, deleted_at, event_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT (clerk_organization_id) DO UPDATE
       SET deleted_at = COALESCE(clerk_organizations.deleted_at, EXCLUDED.deleted_at),
           event_at = GREATEST(clerk_organizations.event_at, EXCLUDED.event_at)`,
    [clerkOrganizationId, clerkOrganizationId, sqlTime(eventAt), sqlTime(eventAt)],
  )
}

/**
 * Adhésion créée, modifiée (`deleted` faux) ou retirée (`deleted` vrai), si l'événement est plus
 * récent que l'état connu ; à date égale, un retrait l'emporte. Une adhésion retirée renaît par
 * un événement plus récent (le compte rejoint de nouveau l'équipe).
 */
export async function applyMembershipMirror(
  membership: { organizationId: string; clerkUserId: string; role: string; deleted: boolean },
  eventAt: DateTime,
  trx: TransactionClientContract,
): Promise<void> {
  const at = sqlTime(eventAt)
  await trx.rawQuery(
    `INSERT INTO clerk_organization_memberships
       (id, clerk_organization_id, clerk_user_id, role, deleted_at, event_at)
     VALUES (?, ?, ?, ?, CASE WHEN ? THEN ?::timestamptz END, ?)
     ON CONFLICT (clerk_organization_id, clerk_user_id) DO UPDATE
       SET role = EXCLUDED.role, deleted_at = EXCLUDED.deleted_at, event_at = EXCLUDED.event_at
       WHERE clerk_organization_memberships.event_at < EXCLUDED.event_at
          OR (clerk_organization_memberships.event_at = EXCLUDED.event_at
              AND EXCLUDED.deleted_at IS NOT NULL)`,
    [
      randomUUID(),
      membership.organizationId,
      membership.clerkUserId,
      membership.role,
      membership.deleted,
      at,
      at,
    ],
  )
}

// --- Événements -----------------------------------------------------------------------------

/**
 * Applique un webhook d'organisation dans la transaction du webhook ; renvoie les accès à
 * revérifier par le service temps réel après validation. Une charge utile illisible est
 * journalisée et ignorée (l'événement reste marqué traité).
 */
export async function applyOrganizationEvent(
  event: { type: string; data: unknown; timestamp?: unknown },
  trx: TransactionClientContract,
): Promise<TeamSyncEffects> {
  const eventAt = billingEventTime(event)
  const ignore = (issues: unknown) => {
    logger.warn({ type: event.type, issues }, 'organization webhook ignored')
    return NO_TEAM_EFFECTS
  }
  if (event.type === 'organization.created' || event.type === 'organization.updated') {
    const parsed = clerkOrganizationSchema.safeParse(event.data)
    if (!parsed.success) return ignore(parsed.error.issues)
    const { id, name, slug, created_by: createdBy } = parsed.data
    await upsertOrganizationMirror(
      { id, name, slug: slug ?? null, createdBy: createdBy ?? null },
      eventAt,
      trx,
    )
    return reconcileOrganization(id, trx)
  }
  if (event.type === 'organization.deleted') {
    const parsed = clerkDeletedObjectSchema.safeParse(event.data)
    if (!parsed.success) return ignore(parsed.error.issues)
    await deleteOrganizationMirror(parsed.data.id, eventAt, trx)
    return reconcileOrganization(parsed.data.id, trx)
  }
  if (event.type.startsWith('organizationMembership.')) {
    const parsed = clerkOrganizationMembershipSchema.safeParse(event.data)
    if (!parsed.success) return ignore(parsed.error.issues)
    const { organization, role, public_user_data: userData } = parsed.data
    // Avant toute écriture : un `user.created` simultané du même compte attend, ou est attendu.
    await lockClerkUser(userData.user_id, trx)
    await seedOrganizationMirror(
      {
        id: organization.id,
        name: organization.name,
        slug: organization.slug ?? null,
        createdBy: organization.created_by ?? null,
      },
      trx,
    )
    await applyMembershipMirror(
      {
        organizationId: organization.id,
        clerkUserId: userData.user_id,
        role,
        deleted: event.type === 'organizationMembership.deleted',
      },
      eventAt,
      trx,
    )
    return reconcileOrganization(organization.id, trx)
  }
  // organizationInvitation.* et autres : rien à refléter (Clerk gère les invitations).
  return NO_TEAM_EFFECTS
}

// --- Réconciliation -------------------------------------------------------------------------

export interface DesiredMember {
  userId: string
  role: 'admin' | 'member'
  banned: boolean
  clerkUserId: string
}

/** Adhésions actives de l'organisation dont le compte est connu (et non supprimé), par arrivée. */
async function desiredMembers(
  clerkOrganizationId: string,
  trx: TransactionClientContract,
): Promise<DesiredMember[]> {
  const rows = (await trx
    .from('clerk_organization_memberships as m')
    .join('users as u', 'u.clerk_user_id', 'm.clerk_user_id')
    .where('m.clerk_organization_id', clerkOrganizationId)
    .whereNull('m.deleted_at')
    .whereNull('u.deleted_at')
    .orderBy([
      { column: 'm.created_at', order: 'asc' },
      { column: 'm.id', order: 'asc' },
    ])
    .select('u.id', 'u.banned_at', 'u.clerk_user_id', 'm.role')) as {
    id: string
    banned_at: Date | null
    clerk_user_id: string
    role: string
  }[]
  return rows.map((row) => ({
    userId: row.id,
    role: workspaceRoleFromClerk(row.role),
    banned: row.banned_at !== null,
    clerkUserId: row.clerk_user_id,
  }))
}

/**
 * Rang d'un membre comme responsable (plus petit : mieux placé) : actif avant banni,
 * administrateur avant simple membre (moindre privilège : un administrateur est déjà
 * propriétaire effectif des projets de l'équipe).
 */
function responsibleRank(member: DesiredMember): number {
  return (member.banned ? 2 : 0) + (member.role === 'admin' ? 0 : 1)
}

/**
 * Responsable du workspace parmi les membres (par arrivée) : le mieux classé
 * (`responsibleRank`) ; à rang égal, le créateur de l'organisation s'il est administrateur, sinon
 * le plus ancien. Null sans membre.
 */
export function pickResponsible(
  members: readonly DesiredMember[],
  creatorClerkUserId: string | null,
): string | null {
  const ranked = members
    .map((member, arrival) => ({
      member,
      arrival,
      creator: member.role === 'admin' && member.clerkUserId === creatorClerkUserId ? 0 : 1,
    }))
    .sort(
      (a, b) =>
        responsibleRank(a.member) - responsibleRank(b.member) ||
        a.creator - b.creator ||
        a.arrival - b.arrival,
    )
  return ranked[0]?.member.userId ?? null
}

/**
 * Responsable à retenir : `currentId` s'il est toujours membre et qu'aucun membre n'est mieux
 * classé que lui (stabilité), sinon `pickResponsible`. Un responsable banni ou rétrogradé est
 * ainsi remplacé dès qu'un membre actif (ou un administrateur) existe.
 */
export function chooseResponsible(
  members: readonly DesiredMember[],
  currentId: string | null,
  creatorClerkUserId: string | null,
): string | null {
  const best = pickResponsible(members, creatorClerkUserId)
  const current = members.find((member) => member.userId === currentId)
  const bestMember = members.find((member) => member.userId === best)
  if (current && bestMember && responsibleRank(current) <= responsibleRank(bestMember)) {
    return current.userId
  }
  return best
}

/**
 * Projets du workspace possédés par `userId` : la propriété passe à `responsibleId` (le projet
 * reste dans l'équipe) et la ligne de membre de l'ancien propriétaire (devenu éditeur) est
 * retirée. Sans responsable (ou responsable banni), ses projets restent à son nom dans
 * l'équipe (journalisé). Renvoie les projets transférés.
 */
async function handOverProjects(
  workspace: Workspace,
  userId: string,
  responsibleId: string | null,
  trx: TransactionClientContract,
): Promise<string[]> {
  const owned = await Project.query({ client: trx })
    .where({ workspaceId: workspace.id, ownerId: userId })
    .orderBy('id')
    .forUpdate()
  if (owned.length === 0) return []
  const responsible =
    responsibleId !== null && responsibleId !== userId
      ? await User.query({ client: trx }).where('id', responsibleId).first()
      : null
  if (!responsible || responsible.deletedAt || responsible.bannedAt) {
    logger.warn(
      { workspaceId: workspace.id, userId, projects: owned.length },
      'team member left without anyone to receive their projects: projects kept by their owner',
    )
    return []
  }
  for (const project of owned) {
    await transferOwnership(project, responsible, trx, null)
    await ProjectMember.query({ client: trx })
      .where({ projectId: project.id, userId, role: 'editor' })
      .delete()
  }
  logger.info(
    { workspaceId: workspace.id, from: userId, to: responsible.id, projects: owned.length },
    'team projects handed over to the workspace owner',
  )
  return owned.map((project) => project.id)
}

async function workspaceProjectIds(
  workspaceId: string,
  trx: TransactionClientContract,
): Promise<string[]> {
  const rows = (await trx.from('projects').where('workspace_id', workspaceId).select('id')) as {
    id: string
  }[]
  return rows.map((row) => row.id)
}

/**
 * Organisation supprimée : chaque projet du workspace rejoint le workspace personnel de son
 * propriétaire, puis le workspace (membres, réserve de crédits) est supprimé. Un projet dont le
 * propriétaire est un compte supprimé (gardé dans l'équipe faute de responsable) est supprimé :
 * un compte supprimé ne retrouve jamais de workspace ni de projet. Ses ressources hors de la base
 * se libèrent après validation (`applyTeamEffects`).
 */
async function dissolveWorkspace(
  workspace: Workspace,
  trx: TransactionClientContract,
): Promise<TeamSyncEffects> {
  const members = (await trx
    .from('workspace_members')
    .where('workspace_id', workspace.id)
    .select('user_id')) as { user_id: string }[]
  const projects = await Project.query({ client: trx })
    .where('workspaceId', workspace.id)
    .orderBy('id')
    .forUpdate()
  const moved: string[] = []
  const deleted: DeletedProject[] = []
  for (const project of projects) {
    const owner = await User.query({ client: trx }).where('id', project.ownerId).first()
    if (!owner || owner.deletedAt) {
      deleted.push(await deleteProjectRows(project, trx))
      continue
    }
    const personal = await ensurePersonalWorkspace(owner, trx)
    project.workspaceId = personal.id
    await project.useTransaction(trx).save()
    moved.push(project.id)
  }
  await workspace.useTransaction(trx).delete()
  logger.info(
    {
      workspaceId: workspace.id,
      projects: moved.length,
      deletedProjects: deleted.length,
      members: members.length,
    },
    'team workspace dissolved: projects moved to their owners',
  )
  const userIds = members.map((member) => member.user_id)
  const changes = moved.length > 0 && userIds.length > 0 ? [{ projectIds: moved, userIds }] : []
  return { changes, deleted }
}

/**
 * Recalcule le workspace d'équipe d'une organisation depuis le miroir (voir l'en-tête du module).
 * Idempotente ; à appeler dans une transaction.
 */
export async function reconcileOrganization(
  clerkOrganizationId: string,
  trx: TransactionClientContract,
): Promise<TeamSyncEffects> {
  await lockTeam(clerkOrganizationId, trx)
  const organization = await ClerkOrganization.query({ client: trx })
    .where('clerkOrganizationId', clerkOrganizationId)
    .first()
  let workspace = await Workspace.query({ client: trx })
    .where('clerkOrganizationId', clerkOrganizationId)
    .forUpdate()
    .first()
  if (organization?.deletedAt) {
    return workspace ? dissolveWorkspace(workspace, trx) : NO_TEAM_EFFECTS
  }

  const desired = await desiredMembers(clerkOrganizationId, trx)
  const creator = organization?.createdByClerkUserId ?? null
  if (!workspace) {
    const ownerId = pickResponsible(desired, creator)
    // Pas encore de membre connu localement, ou organisation sans nom : rien à créer.
    if (ownerId === null || !organization) return NO_TEAM_EFFECTS
    workspace = await Workspace.create(
      {
        name: organization.name,
        type: 'team',
        ownerId,
        clerkOrganizationId,
      },
      { client: trx },
    )
  } else if (organization && organization.name !== workspace.name) {
    workspace.name = organization.name
    await workspace.useTransaction(trx).save()
  }

  const current = (await trx
    .from('workspace_members')
    .where('workspace_id', workspace.id)
    .forUpdate()
    .select('user_id', 'role')) as { user_id: string; role: WorkspaceRole }[]
  const currentRoles = new Map(current.map((row) => [row.user_id, row.role]))
  const desiredIds = new Set(desired.map((member) => member.userId))

  const touched = new Set<string>()
  for (const member of desired) {
    const role = currentRoles.get(member.userId)
    if (role === member.role) continue
    await trx.rawQuery(
      `INSERT INTO workspace_members (id, workspace_id, user_id, role) VALUES (?, ?, ?, ?)
       ON CONFLICT (workspace_id, user_id) DO UPDATE SET role = EXCLUDED.role`,
      [randomUUID(), workspace.id, member.userId, member.role],
    )
    touched.add(member.userId)
  }

  // Responsable : reste tant qu'aucun membre n'est mieux placé (voir `chooseResponsible`).
  const responsible = chooseResponsible(desired, workspace.ownerId, creator)
  if (responsible !== null && responsible !== workspace.ownerId) {
    workspace.ownerId = responsible
    await workspace.useTransaction(trx).save()
  }

  for (const row of current) {
    if (desiredIds.has(row.user_id)) continue
    const handed = await handOverProjects(workspace, row.user_id, responsible, trx)
    // Le responsable devient propriétaire réel : son rôle sur ces projets change aussi.
    if (handed.length > 0 && responsible !== null) touched.add(responsible)
    await trx
      .from('workspace_members')
      .where({ workspace_id: workspace.id, user_id: row.user_id })
      .delete()
    touched.add(row.user_id)
  }

  // Projets restés au nom d'un compte qui n'est plus membre (parti ou supprimé sans responsable
  // pour les recevoir) : repris par le responsable dès qu'il y en a un.
  const orphanOwners = (await trx
    .from('projects')
    .where('workspace_id', workspace.id)
    .if(desiredIds.size > 0, (query) => query.whereNotIn('owner_id', [...desiredIds]))
    .distinct('owner_id')) as { owner_id: string }[]
  for (const { owner_id: ownerId } of orphanOwners) {
    const handed = await handOverProjects(workspace, ownerId, responsible, trx)
    if (handed.length > 0 && responsible !== null) {
      touched.add(responsible)
      touched.add(ownerId)
    }
  }

  if (touched.size === 0) return NO_TEAM_EFFECTS
  const projectIds = await workspaceProjectIds(workspace.id, trx)
  if (projectIds.length === 0) return NO_TEAM_EFFECTS
  return { changes: [{ projectIds, userIds: [...touched] }], deleted: [] }
}

/**
 * Compte local tout juste créé : rattache les adhésions arrivées avant lui (webhooks désordonnés,
 * compte créé à la volée par le guard).
 */
export async function attachPendingMemberships(
  user: User,
  trx: TransactionClientContract,
): Promise<TeamSyncEffects> {
  const rows = (await trx
    .from('clerk_organization_memberships')
    .where('clerk_user_id', user.clerkUserId)
    .whereNull('deleted_at')
    .select('clerk_organization_id')) as { clerk_organization_id: string }[]
  // Verrous `team:…` dans l'ordre commun (`lockTeam`).
  const organizationIds = rows.map((row) => row.clerk_organization_id).sort(byteOrder)
  const effects: TeamSyncEffects[] = []
  for (const organizationId of organizationIds) {
    effects.push(await reconcileOrganization(organizationId, trx))
  }
  return mergeTeamEffects(...effects)
}

/**
 * Compte supprimé : il quitte ses workspaces d'équipe comme un membre retiré (ses projets
 * d'équipe passent au responsable au lieu d'être supprimés avec ses projets personnels ; sans
 * responsable, ils restent dans l'équipe à son nom, voir `reconcileOrganization`). À appeler
 * avant la suppression de ses projets personnels, dans la même transaction.
 */
export async function releaseTeamMemberships(
  user: User,
  trx: TransactionClientContract,
): Promise<TeamSyncEffects> {
  const workspaces = (
    await Workspace.query({ client: trx })
      .join('workspace_members', 'workspace_members.workspace_id', 'workspaces.id')
      .where('workspace_members.user_id', user.id)
      .where('workspaces.type', 'team')
      .select('workspaces.*')
  ).sort((a, b) =>
    // Verrous `team:…` dans l'ordre commun (`lockTeam`) : par organisation.
    byteOrder(a.clerkOrganizationId ?? a.id, b.clerkOrganizationId ?? b.id),
  )
  const changes: TeamAccessChange[] = []
  for (const workspace of workspaces) {
    await lockTeam(workspace.clerkOrganizationId ?? workspace.id, trx)
    const others = (
      workspace.clerkOrganizationId ? await desiredMembers(workspace.clerkOrganizationId, trx) : []
    ).filter((member) => member.userId !== user.id)
    const creator = workspace.clerkOrganizationId
      ? ((
          await ClerkOrganization.query({ client: trx })
            .where('clerkOrganizationId', workspace.clerkOrganizationId)
            .first()
        )?.createdByClerkUserId ?? null)
      : null
    const responsible = chooseResponsible(others, workspace.ownerId, creator)
    if (responsible !== null && responsible !== workspace.ownerId) {
      workspace.ownerId = responsible
      await workspace.useTransaction(trx).save()
    }
    const handed = await handOverProjects(workspace, user.id, responsible, trx)
    await trx
      .from('workspace_members')
      .where({ workspace_id: workspace.id, user_id: user.id })
      .delete()
    const projectIds = await workspaceProjectIds(workspace.id, trx)
    // Le responsable qui reçoit des projets voit son rôle changer sur eux.
    const userIds = handed.length > 0 && responsible !== null ? [user.id, responsible] : [user.id]
    if (projectIds.length > 0) changes.push({ projectIds, userIds })
  }
  return { changes, deleted: [] }
}

/**
 * Après validation : les projets supprimés libèrent leurs documents ouverts et leurs objets S3,
 * puis le service temps réel relit le rôle des comptes concernés sur chaque projet (fermeture des
 * connexions d'un membre retiré, lecture seule ou écriture selon le nouveau rôle). Au mieux : un
 * échec est journalisé par le client, le balayage périodique du service rattrape.
 */
export async function applyTeamEffects(
  services: ProjectReleaseServices,
  effects: TeamSyncEffects,
): Promise<void> {
  for (const project of effects.deleted) await releaseDeletedProject(project, services)
  for (const change of effects.changes) {
    await Promise.all(
      change.projectIds.map((projectId) =>
        services.realtime.membersChanged(projectId, change.userIds),
      ),
    )
  }
}
