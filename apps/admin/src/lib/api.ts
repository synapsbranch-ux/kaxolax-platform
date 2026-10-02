import {
  type AdminAuditAction,
  type AdminAuditLogResponse,
  adminAuditLogResponseSchema,
  type AdminAuditOutcome,
  type AdminAuditTargetType,
  type AdminBanner,
  adminBannerResponseSchema,
  adminBannersResponseSchema,
  type AdminProjectDetail,
  adminProjectResponseSchema,
  type AdminProjectsResponse,
  adminProjectsResponseSchema,
  type AdminProjectView,
  type AdminRevokeSessionsResponse,
  adminRevokeSessionsResponseSchema,
  type AdminUserActionResponse,
  adminUserActionResponseSchema,
  type AdminStats,
  adminStatsSchema,
  type AdminUserDetail,
  adminUserResponseSchema,
  type AdminUserSummary,
  adminUserSummarySchema,
  type AdminUsersResponse,
  adminUsersResponseSchema,
  type CreateBannerInput,
  type UpdateBannerInput,
} from '@kaxolax/contracts'
import { z } from 'zod'

/** Erreur renvoyée par l'API : statut HTTP, code (`E_…`) et message. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | undefined,
    message: string,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

/** Fournit le jeton de session Clerk ; enregistré par `ClerkApiBridge` une fois Clerk chargé. */
export type TokenGetter = () => Promise<string | null>

let resolveTokenGetter: (getter: TokenGetter) => void = () => undefined
let tokenGetter = new Promise<TokenGetter>((resolve) => {
  resolveTokenGetter = resolve
})

export function setTokenGetter(getter: TokenGetter): void {
  resolveTokenGetter(getter)
  tokenGetter = Promise.resolve(getter)
}

const errorBodySchema = z.object({
  code: z.string().optional(),
  message: z.string().optional(),
  errors: z.array(z.object({ message: z.string() })).optional(),
})

function errorFrom(status: number, body: unknown): ApiError {
  const parsed = errorBodySchema.safeParse(body)
  const data = parsed.success ? parsed.data : {}
  const message = data.errors?.[0]?.message ?? data.message ?? `Request failed (${String(status)})`
  return new ApiError(status, data.code, message)
}

/** Appel de l'API (même origine, jeton Clerk en `Authorization`), réponse validée par `schema`. */
async function request<T>(
  method: string,
  path: string,
  schema: z.ZodType<T> | null,
  body?: unknown,
): Promise<T> {
  const headers: Record<string, string> = { accept: 'application/json' }
  if (body !== undefined) headers['content-type'] = 'application/json'
  // Jeton de session Clerk frais (Clerk le renouvelle avant son expiration).
  const token = await (await tokenGetter)()
  if (token !== null) headers.authorization = `Bearer ${token}`
  const response = await fetch(`/api/v1${path}`, {
    method,
    headers,
    credentials: 'omit',
    cache: 'no-store',
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await response.text()
  const data: unknown = text === '' ? null : JSON.parse(text)
  if (!response.ok) throw errorFrom(response.status, data)
  return schema === null ? (undefined as T) : schema.parse(data)
}

/** Paramètres de requête sans les valeurs vides. */
function query(params: Record<string, string | number | null | undefined>): string {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value === null || value === undefined || value === '') continue
    search.set(key, String(value))
  }
  const text = search.toString()
  return text === '' ? '' : `?${text}`
}

export interface AuditLogFilters {
  action?: AdminAuditAction | undefined
  targetType?: AdminAuditTargetType | undefined
  targetId?: string | undefined
  adminId?: string | undefined
  outcome?: AdminAuditOutcome | undefined
  from?: string | undefined
  to?: string | undefined
}

const userSummaryResponseSchema = z.object({ user: adminUserSummarySchema })

/** Routes `/api/v1/admin/*` : l'API revérifie rôle admin et MFA à chaque appel. */
export const adminApi = {
  users: (q: string, page: number): Promise<AdminUsersResponse> =>
    request('GET', `/admin/users${query({ q: q.trim(), page })}`, adminUsersResponseSchema),
  user: async (id: string): Promise<AdminUserDetail> =>
    (await request('GET', `/admin/users/${id}`, adminUserResponseSchema)).user,
  banUser: (id: string): Promise<AdminUserActionResponse> =>
    request('POST', `/admin/users/${id}/ban`, adminUserActionResponseSchema),
  unbanUser: async (id: string): Promise<AdminUserSummary> =>
    (await request('POST', `/admin/users/${id}/unban`, userSummaryResponseSchema)).user,
  revokeSessions: (id: string): Promise<AdminRevokeSessionsResponse> =>
    request('POST', `/admin/users/${id}/revoke-sessions`, adminRevokeSessionsResponseSchema),
  deleteUser: (id: string): Promise<AdminUserActionResponse> =>
    request('DELETE', `/admin/users/${id}`, adminUserActionResponseSchema),

  projects: (q: string, view: AdminProjectView, page: number): Promise<AdminProjectsResponse> =>
    request(
      'GET',
      `/admin/projects${query({ q: q.trim(), view, page })}`,
      adminProjectsResponseSchema,
    ),
  project: async (id: string): Promise<AdminProjectDetail> =>
    (await request('GET', `/admin/projects/${id}`, adminProjectResponseSchema)).project,
  transferProject: async (id: string, newOwnerId: string): Promise<AdminProjectDetail> =>
    (
      await request('POST', `/admin/projects/${id}/transfer`, adminProjectResponseSchema, {
        newOwnerId,
      })
    ).project,
  setProjectState: async (
    id: string,
    action: 'archive' | 'unarchive' | 'trash' | 'restore',
  ): Promise<AdminProjectDetail> =>
    (await request('POST', `/admin/projects/${id}/${action}`, adminProjectResponseSchema)).project,
  deleteProject: (id: string): Promise<void> => request('DELETE', `/admin/projects/${id}`, null),

  banners: (page: number) =>
    request('GET', `/admin/banners${query({ page })}`, adminBannersResponseSchema),
  createBanner: async (input: CreateBannerInput): Promise<AdminBanner> =>
    (await request('POST', '/admin/banners', adminBannerResponseSchema, input)).banner,
  updateBanner: async (id: string, changes: UpdateBannerInput): Promise<AdminBanner> =>
    (await request('PATCH', `/admin/banners/${id}`, adminBannerResponseSchema, changes)).banner,
  /** Termine la bannière à l'heure du serveur. */
  endBanner: async (id: string): Promise<AdminBanner> =>
    (await request('POST', `/admin/banners/${id}/end`, adminBannerResponseSchema)).banner,
  deleteBanner: (id: string): Promise<void> => request('DELETE', `/admin/banners/${id}`, null),

  stats: (from: string, to: string): Promise<AdminStats> =>
    request('GET', `/admin/stats${query({ from, to })}`, adminStatsSchema),

  auditLog: (filters: AuditLogFilters, page: number): Promise<AdminAuditLogResponse> =>
    request('GET', `/admin/audit-log${query({ ...filters, page })}`, adminAuditLogResponseSchema),
}

/** Messages en français des erreurs connues de l'API (les messages de l'API sont en anglais). */
const MESSAGES: Record<string, string> = {
  E_CLERK_UNAVAILABLE: "L'API Backend de Clerk n'est pas configurée sur l'API.",
  E_CLERK_REQUEST_FAILED: "Clerk n'a pas répondu ; réessayez dans un instant.",
  E_INVALID_STATS_PERIOD: 'Période invalide : le début doit précéder la fin (366 jours au plus).',
  E_INVALID_BANNER_PERIOD: 'La fin de la bannière doit être après son début.',
  E_BANNER_NOT_FOUND: 'Bannière introuvable.',
  E_INVALID_NEW_OWNER:
    'Le nouveau propriétaire doit être un compte existant, ni supprimé ni banni.',
  E_ALREADY_OWNER: 'Ce compte est déjà propriétaire du projet.',
  E_USER_NOT_FOUND: 'Utilisateur introuvable.',
  E_ADMIN_SELF_ACTION: 'Action impossible sur votre propre compte.',
  E_USER_DELETED: 'Ce compte a été supprimé.',
  E_PROJECT_NOT_TRASHED: "Mettez d'abord le projet à la corbeille.",
  E_PLAN_LIMIT:
    'Le plan du destinataire ne permet pas ce projet (stockage ou nombre de collaborateurs).',
}

/** Message affichable d'une erreur ; les refus d'accès restent génériques. */
export function errorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    // Limite de plan (403) : un refus métier, pas un refus d'accès.
    if (error.code === 'E_PLAN_LIMIT') return MESSAGES.E_PLAN_LIMIT ?? error.message
    if (error.status === 401 || error.status === 403) return 'Accès refusé.'
    const known = error.code === undefined ? undefined : MESSAGES[error.code]
    if (known !== undefined) return known
    if (error.status === 404) return 'Élément introuvable (supprimé entre-temps ?).'
    if (error.status === 422) return `Données invalides : ${error.message}`
    return error.message
  }
  if (error instanceof z.ZodError) return "Réponse inattendue de l'API."
  return error instanceof Error ? error.message : String(error)
}
