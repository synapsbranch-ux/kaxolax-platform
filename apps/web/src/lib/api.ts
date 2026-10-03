import {
  chatMessageResponseSchema,
  chatMessagesResponseSchema,
  chatUnreadResponseSchema,
  commentThreadResponseSchema,
  commentThreadsResponseSchema,
  documentDiffResponseSchema,
  buildStateSchema,
  compileAcceptedSchema,
  invitationPreviewSchema,
  invitationResponseSchema,
  joinProjectResponseSchema,
  memberResponseSchema,
  projectMembersResponseSchema,
  projectVersionSchema,
  restoreVersionResponseSchema,
  shareLinkPreviewSchema,
  packageSuggestionsSchema,
  shareLinkResponseSchema,
  shareLinksResponseSchema,
  versionDetailSchema,
  versionListResponseSchema,
  templateListResponseSchema,
  templateResponseSchema,
  warmCompilerResponseSchema,
  texlivePackageDetailSchema,
  texlivePackageListSchema,
  wordCountResponseSchema,
  teamAccessSchema,
  workspaceMembersResponseSchema,
  workspacePlanResponseSchema,
  workspacesResponseSchema,
  workspaceSyncResponseSchema,
} from '@kaxolax/contracts'
import type {
  ActiveBanner,
  AssignableRole,
  BuildState,
  CodePosition,
  CompileAccepted,
  CompileOptions,
  Compiler,
  CompileResult,
  CreateCommentThreadInput,
  MePlanResponse,
  PdfPosition,
  PlanLimitError,
  PreferencesResponse,
  ProjectAiSettings,
  ProjectRole,
  ProjectSearchQuery,
  ProjectSearchResponse,
  RealtimeTokenResponse,
  RestoreVersionInput,
  ShareLinkKind,
  SpellcheckLanguage,
  TeamMemberRole,
  TemplateListQuery,
  TemplateListResponse,
  TemplateSummary,
  TexlivePackagesQuery,
  UserPreferences,
  UserRealtimeTokenResponse,
  WorkspaceAiSettings,
} from '@kaxolax/contracts'

import { planLimitOf, reportPlanLimit } from './plan-limits'

export type { Workspace } from '@kaxolax/contracts'

/**
 * Erreur renvoyée par l'API : statut HTTP, code (`E_…`), erreurs de validation éventuelles et
 * corps reçu (`planLimit` : refus 403 `E_PLAN_LIMIT` détaillé).
 */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | undefined,
    message: string,
    readonly fieldErrors: { field: string; message: string }[] = [],
    /** Corps JSON de la réponse (détails d'une erreur : limite du plan, délai d'attente…). */
    readonly body: unknown = null,
  ) {
    super(message)
    this.name = 'ApiError'
  }

  /** Limite du plan atteinte (corps `E_PLAN_LIMIT`), sinon null. */
  get planLimit(): PlanLimitError | null {
    return this.code === 'E_PLAN_LIMIT' ? planLimitOf(this.body) : null
  }
}

export interface User {
  id: string
  email: string
  fullName: string | null
  avatarUrl: string | null
}

export interface Project {
  id: string
  workspaceId: string
  name: string
  compiler: Compiler
  mainDocumentId: string | null
  spellcheckLanguage: SpellcheckLanguage
  /** IA autorisée pour ce projet (réglage du propriétaire). */
  aiEnabled: boolean
  /** Rôle des membres de l'équipe sur ce projet (projet d'un workspace d'équipe). */
  teamRole: TeamMemberRole
  role: ProjectRole
  archivedAt: string | null
  trashedAt: string | null
  lastCompiledAt: string | null
  createdAt: string
  updatedAt: string
}

export interface TreeFolder {
  id: string
  parentId: string | null
  name: string
  path: string
}
export interface TreeDocument {
  id: string
  folderId: string | null
  name: string
  path: string
}
export interface TreeFile {
  id: string
  folderId: string | null
  name: string
  path: string
  sizeBytes: number
  mimeType: string
}
export interface ProjectTree {
  mainDocumentId: string | null
  folders: TreeFolder[]
  documents: TreeDocument[]
  files: TreeFile[]
}
export type EntityType = 'folder' | 'document' | 'file'
export type ProjectView = 'active' | 'archived' | 'trashed'

export interface StartedUpload {
  uploadId: string
  url: string
  method: 'PUT'
  expiresAt: string
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

function errorFrom(status: number, body: unknown): ApiError {
  const data = (typeof body === 'object' && body !== null ? body : {}) as {
    code?: string
    message?: string
    errors?: { field: string; message: string }[]
  }
  const fieldErrors = Array.isArray(data.errors) ? data.errors : []
  const message = fieldErrors[0]?.message ?? data.message ?? `Request failed (${String(status)})`
  const error = new ApiError(status, data.code, message, fieldErrors, body)
  // Limite du plan : la boîte de dialogue globale l'explique (sauf si l'appelant l'affiche).
  const planLimit = error.planLimit
  if (planLimit !== null) reportPlanLimit(planLimit, error)
  return error
}

/**
 * Âge maximal du dernier jeton obtenu pour un envoi synchrone (`sendOnExit`) : les jetons de
 * session Clerk vivent environ 60 s.
 */
const RECENT_TOKEN_MAX_AGE_MS = 45_000
/** Dernier jeton de session obtenu, et sa date (envoi pendant la fermeture de la page). */
let recentToken: { value: string; at: number } | null = null

/** Jeton de session Clerk frais (Clerk le renouvelle avant son expiration, environ 60 s). */
async function freshToken(): Promise<string | null> {
  const token = await (await tokenGetter)()
  if (token !== null) recentToken = { value: token, at: Date.now() }
  return token
}

/**
 * Appel de l'API REST (même origine, jeton de session Clerk) ; corps JSON renvoyé tel quel.
 * Exporté pour les modules d'API par domaine (`lib/zotero.ts`).
 */
export async function apiRequest<T>(method: string, path: string, body?: unknown): Promise<T> {
  return request<T>(method, path, body)
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { accept: 'application/json' }
  if (body !== undefined) headers['content-type'] = 'application/json'
  const token = await freshToken()
  if (token !== null) headers.authorization = `Bearer ${token}`
  const response = await fetch(`/api/v1${path}`, {
    method,
    headers,
    credentials: 'omit',
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await response.text()
  const data: unknown = text === '' ? null : JSON.parse(text)
  if (!response.ok) throw errorFrom(response.status, data)
  return data as T
}

/**
 * Envoi pendant la fermeture ou le masquage de la page : synchrone (aucune attente du jeton, qui
 * n'aboutirait pas), avec le dernier jeton obtenu et `keepalive` pour que la requête survive à la
 * page. Renvoie false sans rien envoyer si aucun jeton récent n'est disponible.
 */
function sendOnExit(method: string, path: string, body: unknown): boolean {
  if (recentToken === null || Date.now() - recentToken.at > RECENT_TOKEN_MAX_AGE_MS) return false
  void fetch(`/api/v1${path}`, {
    method,
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
      authorization: `Bearer ${recentToken.value}`,
    },
    credentials: 'omit',
    body: JSON.stringify(body),
    keepalive: true,
  }).catch(() => undefined)
  return true
}

/** Appels de l'API REST (même origine, jeton de session Clerk dans `Authorization`). */
export const api = {
  me: () => request<{ user: User }>('GET', '/me'),
  /** Plan, features, limites et usage (affichage ; les limites sont appliquées par l'API). */
  plan: () => request<MePlanResponse>('GET', '/me/plan'),
  /** Bannières système affichées maintenant (tout compte connecté). */
  activeBanners: () => request<{ banners: ActiveBanner[] }>('GET', '/banners/active'),
  /** Jeton, URL et nom du canal temps réel du compte (bannière système en direct). */
  userRealtimeToken: () => request<UserRealtimeTokenResponse>('POST', '/me/realtime-token'),

  /** Préférences complètes (valeurs par défaut appliquées par l'API). */
  preferences: () => request<PreferencesResponse>('GET', '/me/preferences'),
  /** Modification partielle (fusion profonde côté API) ; renvoie les préférences complètes. */
  updatePreferences: (patch: UserPreferences) =>
    request<PreferencesResponse>('PATCH', '/me/preferences', patch),
  /** Même modification, envoyée pendant la fermeture de la page (voir `sendOnExit`). */
  updatePreferencesOnExit: (patch: UserPreferences) =>
    sendOnExit('PATCH', '/me/preferences', patch),
  /** Obtient un jeton de session et le garde pour un envoi pendant la fermeture de la page. */
  warmToken: () => freshToken().then(() => undefined),

  workspaces: () =>
    request<unknown>('GET', '/workspaces').then((data) => workspacesResponseSchema.parse(data)),
  /** Membres d'un workspace (tout membre ; emails réservés aux administrateurs). */
  workspaceMembers: (id: string) =>
    request<unknown>('GET', `/workspaces/${id}/members`).then((data) =>
      workspaceMembersResponseSchema.parse(data),
    ),
  /** Plan, limites mutualisées et usage d'un workspace d'équipe (tout membre). */
  workspacePlan: (id: string) =>
    request<unknown>('GET', `/workspaces/${id}/plan`).then((data) =>
      workspacePlanResponseSchema.parse(data),
    ),
  /**
   * Rattrapage de l'organisation active de la session (webhook Clerk en retard) : renvoie le
   * workspace d'équipe de l'utilisateur, ou null.
   */
  syncWorkspace: () =>
    request<unknown>('POST', '/workspaces/sync').then((data) =>
      workspaceSyncResponseSchema.parse(data),
    ),
  /** Déplace un projet personnel vers une équipe (propriétaire du projet, membre de l'équipe). */
  moveProject: (id: string, workspaceId: string) =>
    request<{ project: Project }>('POST', `/projects/${id}/move`, { workspaceId }),
  /** Rôle des membres de l'équipe sur un projet d'équipe (propriétaire, administrateur). */
  setTeamAccess: (id: string, role: TeamMemberRole) =>
    request<{ access: unknown }>('PUT', `/projects/${id}/team-access`, { role }).then((data) =>
      teamAccessSchema.parse(data.access),
    ),

  /** Sans `workspaceId` : tous les projets dont l'utilisateur est membre, partagés compris. */
  projects: (view: ProjectView, q: string, workspaceId: string | null = null) =>
    request<{ projects: Project[] }>(
      'GET',
      `/projects?${new URLSearchParams({
        view,
        ...(q.trim() === '' ? {} : { q: q.trim() }),
        ...(workspaceId === null ? {} : { workspaceId }),
      }).toString()}`,
    ),
  project: (id: string) => request<{ project: Project }>('GET', `/projects/${id}`),
  /** Sans `workspaceId` : le projet rejoint le workspace personnel. */
  createProject: (name: string, workspaceId: string | null = null) =>
    request<{ project: Project }>('POST', '/projects', {
      name,
      ...(workspaceId === null ? {} : { workspaceId }),
    }),
  updateProject: (
    id: string,
    changes: {
      name?: string
      compiler?: Compiler
      mainDocumentId?: string
      spellcheckLanguage?: SpellcheckLanguage
    },
  ) => request<{ project: Project }>('PATCH', `/projects/${id}`, changes),
  /** Activation de l'IA du projet et de son workspace (tout membre). */
  projectAi: (id: string) => request<ProjectAiSettings>('GET', `/projects/${id}/ai`),
  /** Active ou désactive l'IA du projet (propriétaire). */
  updateProjectAi: (id: string, enabled: boolean) =>
    request<ProjectAiSettings>('PUT', `/projects/${id}/ai`, { enabled }),
  /** Activation de l'IA du workspace (membre du workspace). */
  workspaceAi: (id: string) => request<WorkspaceAiSettings>('GET', `/workspaces/${id}/ai`),
  /** Active ou désactive l'IA de tous les projets du workspace (propriétaire du workspace). */
  updateWorkspaceAi: (id: string, enabled: boolean) =>
    request<WorkspaceAiSettings>('PUT', `/workspaces/${id}/ai`, { enabled }),
  setProjectState: (id: string, action: 'archive' | 'unarchive' | 'trash' | 'restore') =>
    request<{ project: Project }>('POST', `/projects/${id}/${action}`),
  deleteProject: (id: string) => request<null>('DELETE', `/projects/${id}`),

  tree: (id: string) => request<ProjectTree>('GET', `/projects/${id}/tree`),
  createFolder: (id: string, name: string, parentId: string | null) =>
    request<{ folder: TreeFolder }>('POST', `/projects/${id}/folders`, { name, parentId }),
  createDocument: (id: string, name: string, folderId: string | null, content = '') =>
    request<{ document: TreeDocument }>('POST', `/projects/${id}/documents`, {
      name,
      folderId,
      content,
    }),
  updateEntity: (
    id: string,
    type: EntityType,
    entityId: string,
    changes: { name?: string; folderId?: string | null },
  ) => request<{ id: string }>('PATCH', `/projects/${id}/entities/${type}/${entityId}`, changes),
  deleteEntity: (id: string, type: EntityType, entityId: string) =>
    request<null>('DELETE', `/projects/${id}/entities/${type}/${entityId}`),
  fileUrl: (id: string, fileId: string, download = false) =>
    request<{ url: string; expiresAt: string }>(
      'GET',
      `/projects/${id}/files/${fileId}/url${download ? '?download=true' : ''}`,
    ),

  startUpload: (
    id: string,
    input: { filename: string; folderId: string | null; sizeBytes: number },
  ) => request<StartedUpload>('POST', `/projects/${id}/uploads`, input),
  completeUpload: (id: string, uploadId: string) =>
    request<unknown>('POST', `/projects/${id}/uploads/${uploadId}/complete`),
  /** `workspaceId` : workspace du futur projet, vérifié avant l'upload (absent : personnel). */
  startImport: (input: { filename: string; sizeBytes: number; workspaceId?: string }) =>
    request<StartedUpload>('POST', '/imports', input),
  completeImport: (uploadId: string, workspaceId: string | null = null) =>
    request<{ project: Project }>(
      'POST',
      `/imports/${uploadId}/complete`,
      workspaceId === null ? {} : { workspaceId },
    ),

  downloadUrl: (id: string) =>
    request<{ url: string; expiresAt: string }>('POST', `/projects/${id}/download-url`),

  // Partage : réponses validées par les schémas de `@kaxolax/contracts` (sharing.ts).
  members: (id: string) =>
    request<unknown>('GET', `/projects/${id}/members`).then((data) =>
      projectMembersResponseSchema.parse(data),
    ),
  updateMemberRole: (id: string, userId: string, role: AssignableRole) =>
    request<unknown>('PATCH', `/projects/${id}/members/${userId}`, { role }).then((data) =>
      memberResponseSchema.parse(data),
    ),
  /** Retirer un membre (propriétaire), ou quitter le projet (son propre id). */
  removeMember: (id: string, userId: string) =>
    request<null>('DELETE', `/projects/${id}/members/${userId}`),
  transferOwnership: (id: string, userId: string) =>
    request<unknown>('POST', `/projects/${id}/transfer`, { userId }).then((data) =>
      projectMembersResponseSchema.parse(data),
    ),
  invite: (id: string, email: string, role: AssignableRole) =>
    request<unknown>('POST', `/projects/${id}/invitations`, { email, role }).then((data) =>
      invitationResponseSchema.parse(data),
    ),
  resendInvitation: (id: string, invitationId: string) =>
    request<unknown>('POST', `/projects/${id}/invitations/${invitationId}/resend`).then((data) =>
      invitationResponseSchema.parse(data),
    ),
  cancelInvitation: (id: string, invitationId: string) =>
    request<null>('DELETE', `/projects/${id}/invitations/${invitationId}`),
  shareLinks: (id: string) =>
    request<unknown>('GET', `/projects/${id}/share-links`).then((data) =>
      shareLinksResponseSchema.parse(data),
    ),
  setShareLink: (id: string, kind: ShareLinkKind, enabled: boolean) =>
    request<unknown>('PUT', `/projects/${id}/share-links/${kind}`, { enabled }).then((data) =>
      shareLinkResponseSchema.parse(data),
    ),
  regenerateShareLink: (id: string, kind: ShareLinkKind) =>
    request<unknown>('POST', `/projects/${id}/share-links/${kind}/regenerate`).then((data) =>
      shareLinkResponseSchema.parse(data),
    ),
  /** Aperçu public d'une invitation (sans compte). */
  invitationPreview: (token: string) =>
    request<unknown>('GET', `/invitations/${encodeURIComponent(token)}`).then((data) =>
      invitationPreviewSchema.parse(data),
    ),
  acceptInvitation: (token: string) =>
    request<unknown>('POST', `/invitations/${encodeURIComponent(token)}/accept`).then((data) =>
      joinProjectResponseSchema.parse(data),
    ),
  /** Aperçu public d'un lien de partage (sans compte). */
  shareLinkPreview: (token: string) =>
    request<unknown>('GET', `/share/${encodeURIComponent(token)}`).then((data) =>
      shareLinkPreviewSchema.parse(data),
    ),
  joinShareLink: (token: string) =>
    request<unknown>('POST', `/share/${encodeURIComponent(token)}/join`).then((data) =>
      joinProjectResponseSchema.parse(data),
    ),

  // Chat du projet : réponses validées par les schémas de `@kaxolax/contracts` (chat.ts).
  /** Historique : les plus récents, ou avant / après un message (un seul curseur). */
  chatMessages: (id: string, cursor: { before?: string; after?: string } = {}) =>
    request<unknown>(
      'GET',
      `/projects/${id}/chat/messages?${new URLSearchParams({
        ...(cursor.before === undefined ? {} : { before: cursor.before }),
        ...(cursor.after === undefined ? {} : { after: cursor.after }),
      }).toString()}`,
    ).then((data) => chatMessagesResponseSchema.parse(data)),
  sendChatMessage: (id: string, body: string) =>
    request<unknown>('POST', `/projects/${id}/chat/messages`, { body }).then((data) =>
      chatMessageResponseSchema.parse(data),
    ),
  /** Marque comme lu jusqu'au message `upTo` (inclus), ou jusqu'à maintenant. */
  markChatRead: (id: string, upTo?: string) =>
    request<unknown>('POST', `/projects/${id}/chat/read`, upTo === undefined ? {} : { upTo }).then(
      (data) => chatUnreadResponseSchema.parse(data),
    ),

  // Commentaires ancrés : réponses validées par les schémas de `@kaxolax/contracts` (comments.ts).
  commentThreads: (id: string) =>
    request<unknown>('GET', `/projects/${id}/comment-threads`).then(
      (data) => commentThreadsResponseSchema.parse(data).threads,
    ),
  /** Un fil ; null s'il n'existe plus (404). */
  commentThread: (id: string, threadId: string) =>
    request<unknown>('GET', `/projects/${id}/comment-threads/${threadId}`).then(
      (data) => commentThreadResponseSchema.parse(data).thread,
      (caught: unknown) => {
        if (caught instanceof ApiError && caught.status === 404) return null
        throw caught
      },
    ),
  createCommentThread: (id: string, input: CreateCommentThreadInput) =>
    request<unknown>('POST', `/projects/${id}/comment-threads`, input).then(
      (data) => commentThreadResponseSchema.parse(data).thread,
    ),
  replyToComment: (id: string, threadId: string, body: string) =>
    request<unknown>('POST', `/projects/${id}/comment-threads/${threadId}/comments`, {
      body,
    }).then((data) => commentThreadResponseSchema.parse(data).thread),
  editComment: (id: string, threadId: string, commentId: string, body: string) =>
    request<unknown>('PATCH', `/projects/${id}/comment-threads/${threadId}/comments/${commentId}`, {
      body,
    }).then((data) => commentThreadResponseSchema.parse(data).thread),
  /** Supprime son message ; null si le fil a disparu avec lui. */
  deleteComment: (id: string, threadId: string, commentId: string) =>
    request<unknown>(
      'DELETE',
      `/projects/${id}/comment-threads/${threadId}/comments/${commentId}`,
    ).then((data) => commentThreadResponseSchema.parse(data).thread),
  setCommentThreadResolved: (id: string, threadId: string, resolved: boolean) =>
    request<unknown>(
      'POST',
      `/projects/${id}/comment-threads/${threadId}/${resolved ? 'resolve' : 'reopen'}`,
    ).then((data) => commentThreadResponseSchema.parse(data).thread),
  // Galerie de templates (publique) et création d'un projet depuis un template.
  templates: (query: TemplateListQuery = {}): Promise<TemplateListResponse> =>
    request<unknown>(
      'GET',
      `/templates?${new URLSearchParams(
        Object.entries(query).flatMap(([key, value]) =>
          typeof value === 'string' && value !== '' ? [[key, value]] : [],
        ),
      ).toString()}`,
    ).then((data) => templateListResponseSchema.parse(data)),
  template: (templateId: string): Promise<TemplateSummary> =>
    request<unknown>('GET', `/templates/${encodeURIComponent(templateId)}`).then(
      (data) => templateResponseSchema.parse(data).template,
    ),
  /** Sans `name` : titre du template ; sans `workspaceId` : workspace personnel. */
  createProjectFromTemplate: (input: { templateId: string; name?: string; workspaceId?: string }) =>
    request<{ project: Project }>('POST', '/projects/from-template', input),

  realtimeToken: (id: string) =>
    request<RealtimeTokenResponse>('POST', `/projects/${id}/realtime-token`),

  /**
   * Compilation : résultat direct (mode `gateway`, synchrone) ou demande acceptée (202
   * `{ buildId, status }`, mode `cloudflare`), dont le résultat arrive par l'événement
   * `compile.updated` du projet ou par `build()`. `auto` : auto-compilation (pas de version dans
   * l'historique).
   */
  compile: (id: string, options: CompileOptions = {}, trigger: 'manual' | 'auto' = 'manual') =>
    request<unknown>('POST', `/projects/${id}/compile`, { options, trigger }).then(
      (
        data,
      ):
        | { kind: 'result'; result: CompileResult }
        | { kind: 'accepted'; accepted: CompileAccepted } => {
        const accepted = compileAcceptedSchema.safeParse(data)
        return accepted.success
          ? { kind: 'accepted', accepted: accepted.data }
          : { kind: 'result', result: data as CompileResult }
      },
    ),
  // Historique (packages/contracts/src/history.ts).
  versions: (id: string, before?: string) =>
    request<unknown>(
      'GET',
      `/projects/${id}/versions${before === undefined ? '' : `?${new URLSearchParams({ before }).toString()}`}`,
    ).then((data) => versionListResponseSchema.parse(data)),
  version: (id: string, versionId: string) =>
    request<unknown>('GET', `/projects/${id}/versions/${versionId}`).then((data) =>
      versionDetailSchema.parse(data),
    ),
  versionDiff: (id: string, versionId: string, documentId: string) =>
    request<unknown>(
      'GET',
      `/projects/${id}/versions/${versionId}/documents/${documentId}/diff`,
    ).then((data) => documentDiffResponseSchema.parse(data)),
  versionFileUrl: (id: string, versionId: string, fileId: string) =>
    request<{ url: string }>('GET', `/projects/${id}/versions/${versionId}/files/${fileId}/url`),
  labelVersion: (id: string, versionId: string, label: string | null) =>
    request<{ version: unknown }>('PATCH', `/projects/${id}/versions/${versionId}`, {
      label,
    }).then((data) => projectVersionSchema.parse(data.version)),
  restoreVersion: (id: string, versionId: string, input: RestoreVersionInput) =>
    request<unknown>('POST', `/projects/${id}/versions/${versionId}/restore`, input).then((data) =>
      restoreVersionResponseSchema.parse(data),
    ),
  versionDownloadUrl: (id: string, versionId: string) =>
    request<{ url: string; expiresAt: string }>(
      'POST',
      `/projects/${id}/versions/${versionId}/download-url`,
    ),
  /** État d'une compilation asynchrone (repli par sondage des événements `compile.updated`). */
  build: (id: string, buildId: string): Promise<BuildState> =>
    request<{ build: unknown }>('GET', `/projects/${id}/builds/${buildId}`).then((data) =>
      buildStateSchema.parse(data.build),
    ),
  /** Réveil anticipé du compilateur du projet (sans effet en mode synchrone). */
  warmCompiler: (id: string) =>
    request<unknown>('POST', `/projects/${id}/compiler/warm`).then((data) =>
      warmCompilerResponseSchema.parse(data),
    ),
  stopCompile: (id: string) =>
    request<{ stopped: boolean }>('POST', `/projects/${id}/compile/stop`),
  lastCompile: (id: string) =>
    request<{ compile: CompileResult | null }>('GET', `/projects/${id}/compile/last`),
  clearCache: (id: string) =>
    request<{ cleared: boolean }>('POST', `/projects/${id}/compile/clear-cache`),
  /** Recherche dans le texte de tous les documents du projet. */
  search: (id: string, query: ProjectSearchQuery) =>
    request<ProjectSearchResponse>(
      'GET',
      `/projects/${id}/search?${new URLSearchParams({
        q: query.q,
        caseSensitive: String(query.caseSensitive),
        wholeWord: String(query.wholeWord),
        regex: String(query.regex),
      }).toString()}`,
    ),
  /**
   * Comptage des mots par texcount dans le sandbox : document principal, ou `documentId`
   * (et les fichiers qu'il inclut).
   */
  wordCount: (id: string, documentId: string | null = null) =>
    request<unknown>(
      'POST',
      `/projects/${id}/word-count`,
      documentId === null ? {} : { documentId },
    ).then((data) => wordCountResponseSchema.parse(data)),

  // Index des packages TeX Live (réponses validées par `@kaxolax/contracts`, texlive.ts).
  texlivePackages: (query: Partial<TexlivePackagesQuery>) =>
    request<unknown>(
      'GET',
      `/texlive/packages?${new URLSearchParams(
        Object.entries(query).map(([key, value]) => [key, String(value)]),
      ).toString()}`,
    ).then((data) => texlivePackageListSchema.parse(data)),
  /** Fiche d'un package (nom TeX Live ou nom passé à `\usepackage`). */
  texlivePackage: (name: string) =>
    request<unknown>('GET', `/texlive/packages/${encodeURIComponent(name)}`).then((data) =>
      texlivePackageDetailSchema.parse(data),
    ),
  /** Noms proches d'un package ou d'un fichier introuvable (`amsmth`, `graphix.sty`). */
  packageSuggestions: (name: string) =>
    request<unknown>(
      'GET',
      `/texlive/suggestions?${new URLSearchParams({ name }).toString()}`,
    ).then((data) => packageSuggestionsSchema.parse(data)),

  synctexCode: (id: string, file: string, line: number, column = 0) =>
    request<{ pdf: PdfPosition[] }>(
      'GET',
      `/projects/${id}/synctex/code?${new URLSearchParams({ file, line: String(line), column: String(column) }).toString()}`,
    ),
  synctexPdf: (id: string, page: number, h: number, v: number) =>
    request<{ code: CodePosition[] }>(
      'GET',
      `/projects/${id}/synctex/pdf?${new URLSearchParams({ page: String(page), h: String(h), v: String(v) }).toString()}`,
    ),
}

/** PUT direct vers S3 (URL présignée, taille signée), puis complétion côté API. */
export async function uploadToProject(
  projectId: string,
  file: File,
  folderId: string | null,
): Promise<void> {
  const started = await api.startUpload(projectId, {
    filename: file.name,
    folderId,
    sizeBytes: file.size,
  })
  const put = await fetch(started.url, { method: 'PUT', body: file })
  if (!put.ok) throw new ApiError(put.status, 'E_UPLOAD_FAILED', `Upload of ${file.name} failed`)
  await api.completeUpload(projectId, started.uploadId)
}

/** Importe un zip comme nouveau projet (workspace donné, sinon workspace personnel). */
export async function importZip(file: File, workspaceId: string | null = null): Promise<Project> {
  const started = await api.startImport({
    filename: file.name,
    sizeBytes: file.size,
    ...(workspaceId === null ? {} : { workspaceId }),
  })
  const put = await fetch(started.url, { method: 'PUT', body: file })
  if (!put.ok) throw new ApiError(put.status, 'E_UPLOAD_FAILED', `Upload of ${file.name} failed`)
  return (await api.completeImport(started.uploadId, workspaceId)).project
}

/** Valeur texte d'un champ de formulaire (chaîne vide si absent). */
export function formValue(form: FormData, name: string): string {
  const value = form.get(name)
  return typeof value === 'string' ? value : ''
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Message français d'une erreur de l'API : `messages` par code (`E_…`), sinon selon le statut
 * HTTP (les messages de l'API sont en anglais). Une autre erreur garde son message.
 */
export function localizedErrorMessage(
  error: unknown,
  messages: Readonly<Record<string, string>>,
): string {
  if (!(error instanceof ApiError)) return errorMessage(error)
  const known = error.code === undefined ? undefined : messages[error.code]
  if (known !== undefined) return known
  if (error.status === 401) return 'Votre session a expiré : reconnectez-vous.'
  if (error.status === 403) return 'Vous n’avez pas les droits nécessaires pour cette action.'
  if (error.status === 404) return 'Élément introuvable : il a peut-être été supprimé.'
  if (error.status === 409) return 'Conflit avec une modification récente : réessayez.'
  if (error.status === 422 || error.status === 400) return 'Requête invalide.'
  if (error.status === 429) return 'Trop de demandes : réessayez dans un instant.'
  return 'Une erreur est survenue. Réessayez dans un instant.'
}
