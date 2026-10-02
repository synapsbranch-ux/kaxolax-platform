import { z } from 'zod'
import { buildStatusSchema } from './builds.js'
import { compileStatusSchema, compilerSchema } from './common.js'
import { projectRoleSchema } from './realtime.js'
import { workspaceTypeSchema } from './workspaces.js'

/**
 * Admin (apps/admin) : contrats des routes `/api/v1/admin/*` et de `GET /api/v1/banners/active`.
 * Les dates sont des chaînes ISO 8601 en UTC.
 */

/** Rôle Clerk qui ouvre l'admin : `publicMetadata.role`, claim `metadata.role` du jeton. */
export const ADMIN_ROLE = 'admin'

/** Refus d'accès à l'admin (403) : rôle absent, ou second facteur non vérifié ou non activé. */
export const ADMIN_REQUIRED_ERROR = 'E_ADMIN_REQUIRED'
export const ADMIN_MFA_REQUIRED_ERROR = 'E_ADMIN_MFA_REQUIRED'

const isoDate = z.iso.datetime()
/** Date saisie dans un formulaire : décalage horaire accepté, l'API la convertit en UTC. */
const isoDateInput = z.iso.datetime({ offset: true })
const count = z.number().int().nonnegative()

// --- Pagination -----------------------------------------------------------------------------

export const ADMIN_DEFAULT_PAGE_SIZE = 25
export const ADMIN_MAX_PAGE_SIZE = 100

/** Pagination d'une liste de l'admin (`?page=&perPage=`). */
export const adminPaginationSchema = z.object({
  page: z.number().int().min(1),
  perPage: z.number().int().min(1).max(ADMIN_MAX_PAGE_SIZE),
  total: count,
  lastPage: z.number().int().min(1),
})
export type AdminPagination = z.infer<typeof adminPaginationSchema>

/** Compte cité par une autre ressource (propriétaire, auteur d'une action). */
export const adminUserRefSchema = z.object({
  id: z.uuid(),
  email: z.string(),
  fullName: z.string().nullable(),
})
export type AdminUserRef = z.infer<typeof adminUserRefSchema>

// --- Utilisateurs ---------------------------------------------------------------------------

/** Ligne de la liste des utilisateurs (`GET /admin/users?q=`). */
export const adminUserSummarySchema = z.object({
  id: z.uuid(),
  clerkUserId: z.string(),
  email: z.string(),
  fullName: z.string().nullable(),
  avatarUrl: z.string().nullable(),
  /** Slug du plan Clerk de l'abonnement en cours, `free` sans abonnement. */
  planSlug: z.string(),
  createdAt: isoDate,
  bannedAt: isoDate.nullable(),
  /** Compte supprimé dans Clerk : la ligne est anonymisée. */
  deletedAt: isoDate.nullable(),
})
export type AdminUserSummary = z.infer<typeof adminUserSummarySchema>

export const adminUsersResponseSchema = z.object({
  users: z.array(adminUserSummarySchema),
  pagination: adminPaginationSchema,
})
export type AdminUsersResponse = z.infer<typeof adminUsersResponseSchema>

/** Limites chiffrées d'un plan (table plan_limits) ; null : illimité. */
export const adminPlanLimitsSchema = z.object({
  maxCompileSeconds: z.number().int().positive(),
  maxCollaborators: count.nullable(),
  historyRetentionDays: z.number().int().positive().nullable(),
  storageBytes: count,
})
export type AdminPlanLimits = z.infer<typeof adminPlanLimitsSchema>

/** Fiche d'un utilisateur (`GET /admin/users/:id`). */
export const adminUserDetailSchema = adminUserSummarySchema.extend({
  plan: z.object({
    slug: z.string(),
    /** Statut Clerk de l'abonnement (active, past_due…), null sans abonnement. */
    status: z.string().nullable(),
    periodEnd: isoDate.nullable(),
    /** Null si le plan n'a pas de ligne dans plan_limits. */
    limits: adminPlanLimitsSchema.nullable(),
  }),
  /** Projets dont il est propriétaire. */
  ownedProjects: count,
  /** Projets d'autres comptes dont il est membre. */
  memberProjects: count,
  /** Somme des tailles des fichiers binaires de ses projets. */
  storageBytes: count,
  /** État lu par l'API Backend de Clerk ; null si Clerk n'a pas répondu ou ne connaît pas le compte. */
  clerk: z
    .object({
      lastSignInAt: isoDate.nullable(),
      lastActiveAt: isoDate.nullable(),
      twoFactorEnabled: z.boolean(),
      banned: z.boolean(),
    })
    .nullable(),
})
export type AdminUserDetail = z.infer<typeof adminUserDetailSchema>

export const adminUserResponseSchema = z.object({ user: adminUserDetailSchema })

/**
 * Déconnexion temps réel qui suit un bannissement, une révocation ou une suppression : false si
 * le service temps réel n'a pas répondu (ses documents peuvent rester ouverts ; à réessayer avec
 * « Révoquer les sessions »).
 */
const realtimeDisconnected = z.boolean()

/** `POST /admin/users/:id/ban` et `DELETE /admin/users/:id`. */
export const adminUserActionResponseSchema = z.object({
  user: adminUserSummarySchema,
  realtimeDisconnected,
})
export type AdminUserActionResponse = z.infer<typeof adminUserActionResponseSchema>

/** `POST /admin/users/:id/revoke-sessions`. */
export const adminRevokeSessionsResponseSchema = z.object({
  revokedSessions: count,
  realtimeDisconnected,
})
export type AdminRevokeSessionsResponse = z.infer<typeof adminRevokeSessionsResponseSchema>

// --- Projets --------------------------------------------------------------------------------

export const ADMIN_PROJECT_VIEWS = ['all', 'active', 'archived', 'trashed'] as const
export const adminProjectViewSchema = z.enum(ADMIN_PROJECT_VIEWS)
export type AdminProjectView = z.infer<typeof adminProjectViewSchema>

/** Ligne de la liste des projets (`GET /admin/projects?q=`) : métadonnées seulement. */
export const adminProjectSummarySchema = z.object({
  id: z.uuid(),
  name: z.string(),
  owner: adminUserRefSchema,
  workspaceId: z.uuid(),
  compiler: compilerSchema,
  /** Fichiers binaires + états des documents, en octets. */
  sizeBytes: count,
  memberCount: count,
  archivedAt: isoDate.nullable(),
  trashedAt: isoDate.nullable(),
  lastCompiledAt: isoDate.nullable(),
  createdAt: isoDate,
  updatedAt: isoDate,
})
export type AdminProjectSummary = z.infer<typeof adminProjectSummarySchema>

export const adminProjectsResponseSchema = z.object({
  projects: z.array(adminProjectSummarySchema),
  pagination: adminPaginationSchema,
})
export type AdminProjectsResponse = z.infer<typeof adminProjectsResponseSchema>

/** Fiche d'un projet (`GET /admin/projects/:id`) : jamais de nom de fichier ni de contenu. */
export const adminProjectDetailSchema = adminProjectSummarySchema.extend({
  workspace: z.object({
    id: z.uuid(),
    name: z.string(),
    type: workspaceTypeSchema,
    ownerId: z.uuid(),
  }),
  storage: z.object({ filesBytes: count, documentsBytes: count }),
  fileCount: count,
  documentCount: count,
  folderCount: count,
  members: z.array(
    z.object({ user: adminUserRefSchema, role: projectRoleSchema, createdAt: isoDate }),
  ),
  lastCompile: z
    .object({
      id: z.uuid(),
      // Statut final, ou état d'une compilation asynchrone (mode cloudflare) encore en cours.
      status: buildStatusSchema,
      compiler: compilerSchema,
      durationMs: count,
      agentId: z.string().nullable(),
      userId: z.uuid(),
      createdAt: isoDate,
    })
    .nullable(),
})
export type AdminProjectDetail = z.infer<typeof adminProjectDetailSchema>

export const adminProjectResponseSchema = z.object({ project: adminProjectDetailSchema })

/**
 * `POST /admin/projects/:id/transfer` : le nouveau propriétaire (compte existant, ni supprimé ni banni)
 * reçoit le projet dans son workspace personnel ; l'ancien devient éditeur.
 */
export const transferProjectInputSchema = z.object({ newOwnerId: z.uuid() })
export type TransferProjectInput = z.infer<typeof transferProjectInputSchema>

// --- Bannière système -----------------------------------------------------------------------

export const BANNER_LEVELS = ['info', 'warning', 'maintenance'] as const
export const bannerLevelSchema = z.enum(BANNER_LEVELS)
export type BannerLevel = z.infer<typeof bannerLevelSchema>

export const BANNER_MESSAGE_MAX_LENGTH = 500

/** Bannière vue par les utilisateurs connectés (`GET /banners/active`). */
export const activeBannerSchema = z.object({
  id: z.uuid(),
  message: z.string(),
  level: bannerLevelSchema,
  startsAt: isoDate,
  /** Null : affichée jusqu'à ce qu'un admin la termine. */
  endsAt: isoDate.nullable(),
})
export type ActiveBanner = z.infer<typeof activeBannerSchema>

export const activeBannersResponseSchema = z.object({ banners: z.array(activeBannerSchema) })
export type ActiveBannersResponse = z.infer<typeof activeBannersResponseSchema>

/** Intervalle de rafraîchissement conseillé côté navigateur (en attendant la diffusion en direct). */
export const BANNER_POLL_INTERVAL_MS = 60_000

/** État d'une bannière à l'instant de la réponse. */
export const bannerStatusSchema = z.enum(['scheduled', 'active', 'ended'])
export type BannerStatus = z.infer<typeof bannerStatusSchema>

/** Bannière dans l'admin (`GET /admin/banners`). */
export const adminBannerSchema = activeBannerSchema.extend({
  status: bannerStatusSchema,
  createdBy: adminUserRefSchema,
  createdAt: isoDate,
})
export type AdminBanner = z.infer<typeof adminBannerSchema>

export const adminBannersResponseSchema = z.object({
  banners: z.array(adminBannerSchema),
  pagination: adminPaginationSchema,
})
export const adminBannerResponseSchema = z.object({ banner: adminBannerSchema })

const bannerMessage = z.string().trim().min(1).max(BANNER_MESSAGE_MAX_LENGTH)
const endsAfterStart = (input: { startsAt?: string | undefined; endsAt?: string | null }) =>
  input.startsAt === undefined ||
  input.endsAt === undefined ||
  input.endsAt === null ||
  Date.parse(input.endsAt) > Date.parse(input.startsAt)
const endsAfterStartIssue = { message: 'The end must be after the start', path: ['endsAt'] }

/** `POST /admin/banners` : début par défaut maintenant, fin facultative (après le début). */
export const createBannerInputSchema = z
  .object({
    message: bannerMessage,
    level: bannerLevelSchema,
    startsAt: isoDateInput.optional(),
    endsAt: isoDateInput.nullable().optional(),
  })
  .refine(endsAfterStart, endsAfterStartIssue)
export type CreateBannerInput = z.infer<typeof createBannerInputSchema>

/**
 * `PATCH /admin/banners/:id` : champs modifiés seulement. L'API vérifie aussi la fin contre le
 * début enregistré quand un seul des deux change.
 */
export const updateBannerInputSchema = z
  .object({
    message: bannerMessage.optional(),
    level: bannerLevelSchema.optional(),
    startsAt: isoDateInput.optional(),
    endsAt: isoDateInput.nullable().optional(),
  })
  .refine(endsAfterStart, endsAfterStartIssue)
export type UpdateBannerInput = z.infer<typeof updateBannerInputSchema>

// --- Statistiques ---------------------------------------------------------------------------

/** Période maximale d'une demande de statistiques. */
export const ADMIN_STATS_MAX_DAYS = 366
export const ADMIN_STATS_DEFAULT_DAYS = 30

const rate = z.number().min(0).max(1).nullable()

/**
 * `GET /admin/stats?from=&to=` (30 derniers jours par défaut). Utilisateur actif sur N jours :
 * compte non supprimé qui a lancé une compilation, est auteur d'une version (historique) ou est
 * propriétaire d'un projet modifié pendant ces N jours. Échec de compilation : tout statut autre
 * que `success` (erreurs LaTeX, dépassement de durée, erreur du service).
 */
export const adminStatsSchema = z.object({
  period: z.object({ from: isoDate, to: isoDate }),
  signups: z.object({
    total: count,
    /** Un point par jour (UTC) de la période, jours sans inscription compris. */
    byDay: z.array(z.object({ date: z.iso.date(), count })),
  }),
  /** Fenêtres glissantes qui se terminent à la fin de la période. */
  activeUsers: z.object({ last7Days: count, last30Days: count }),
  subscriptions: z.object({
    /** Comptes distincts avec un abonnement Pro au statut `active`. */
    pro: count,
    byPlan: z.array(z.object({ planSlug: z.string(), active: count, pastDue: count })),
  }),
  compiles: z.object({
    total: count,
    byStatus: z.record(compileStatusSchema, count),
    averageDurationMs: z.number().nonnegative().nullable(),
    failureRate: rate,
    byAgent: z.array(
      z.object({
        /** Null : compilation sans agent (service indisponible). */
        agentId: z.string().nullable(),
        total: count,
        averageDurationMs: z.number().nonnegative().nullable(),
        failureRate: rate,
      }),
    ),
  }),
})
export type AdminStats = z.infer<typeof adminStatsSchema>

// --- Journal --------------------------------------------------------------------------------

export const ADMIN_AUDIT_ACTIONS = [
  'user.ban',
  'user.unban',
  'user.revoke_sessions',
  'user.delete',
  'user.realtime_disconnect',
  'project.transfer',
  'project.archive',
  'project.unarchive',
  'project.trash',
  'project.restore',
  'project.delete',
  'banner.create',
  'banner.update',
  'banner.delete',
] as const
export const adminAuditActionSchema = z.enum(ADMIN_AUDIT_ACTIONS)
export type AdminAuditAction = z.infer<typeof adminAuditActionSchema>

export const ADMIN_AUDIT_TARGET_TYPES = ['user', 'project', 'banner'] as const
export const adminAuditTargetTypeSchema = z.enum(ADMIN_AUDIT_TARGET_TYPES)
export type AdminAuditTargetType = z.infer<typeof adminAuditTargetTypeSchema>

/** Réussite, ou échec significatif (service externe en erreur, erreur interne). */
export const adminAuditOutcomeSchema = z.enum(['success', 'failure'])
export type AdminAuditOutcome = z.infer<typeof adminAuditOutcomeSchema>

/** Entrée du journal (`GET /admin/audit-log`). */
export const adminAuditEntrySchema = z.object({
  id: z.uuid(),
  admin: adminUserRefSchema,
  action: adminAuditActionSchema,
  targetType: adminAuditTargetTypeSchema,
  /** Uuid local de la cible. */
  targetId: z.string().nullable(),
  outcome: adminAuditOutcomeSchema,
  metadata: z.record(z.string(), z.unknown()),
  createdAt: isoDate,
})
export type AdminAuditEntry = z.infer<typeof adminAuditEntrySchema>

export const adminAuditLogResponseSchema = z.object({
  entries: z.array(adminAuditEntrySchema),
  pagination: adminPaginationSchema,
})
export type AdminAuditLogResponse = z.infer<typeof adminAuditLogResponseSchema>
