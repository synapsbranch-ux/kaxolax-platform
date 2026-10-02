import {
  chatMessageResponseSchema,
  chatMessagesResponseSchema,
  chatUnreadResponseSchema,
  commentThreadResponseSchema,
  commentThreadsResponseSchema,
  documentDiffResponseSchema,
  invitationPreviewSchema,
  invitationResponseSchema,
  joinProjectResponseSchema,
  memberResponseSchema,
  projectMembersResponseSchema,
  projectVersionSchema,
  restoreVersionResponseSchema,
  shareLinkPreviewSchema,
  shareLinkResponseSchema,
  shareLinksResponseSchema,
  versionDetailSchema,
  versionListResponseSchema,
} from '@kaxolax/contracts'
import type {
  ActiveBanner,
  AssignableRole,
  CodePosition,
  CompileOptions,
  Compiler,
  CompileResult,
  CreateCommentThreadInput,
  PdfPosition,
  PreferencesResponse,
  ProjectRole,
  ProjectSearchQuery,
  ProjectSearchResponse,
  RealtimeTokenResponse,
  RestoreVersionInput,
  ShareLinkKind,
  SpellcheckLanguage,
  UserPreferences,
  Workspace,
} from '@kaxolax/contracts'

export type { Workspace } from '@kaxolax/contracts'

/** Erreur renvoyée par l'API : statut HTTP, code (`E_…`) et erreurs de validation éventuelles. */
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
  return new ApiError(status, data.code, message, fieldErrors, body)
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
  /** Bannières système affichées maintenant (tout compte connecté). */
  activeBanners: () => request<{ banners: ActiveBanner[] }>('GET', '/banners/active'),

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

  workspaces: () => request<{ workspaces: Workspace[] }>('GET', '/workspaces'),

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
  startImport: (input: { filename: string; sizeBytes: number }) =>
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

  realtimeToken: (id: string) =>
    request<RealtimeTokenResponse>('POST', `/projects/${id}/realtime-token`),

  /** `auto` : auto-compilation (pas de version dans l'historique). */
  compile: (id: string, options: CompileOptions = {}, trigger: 'manual' | 'auto' = 'manual') =>
    request<CompileResult>('POST', `/projects/${id}/compile`, { options, trigger }),

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
  const started = await api.startImport({ filename: file.name, sizeBytes: file.size })
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
