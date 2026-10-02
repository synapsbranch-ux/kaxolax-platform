import type {
  ActiveBanner,
  CodePosition,
  CompileOptions,
  Compiler,
  CompileResult,
  MePlanResponse,
  PdfPosition,
  PlanLimitError,
  PreferencesResponse,
  ProjectRole,
  ProjectSearchQuery,
  ProjectSearchResponse,
  RealtimeTokenResponse,
  SpellcheckLanguage,
  UserPreferences,
  Workspace,
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

  realtimeToken: (id: string) =>
    request<RealtimeTokenResponse>('POST', `/projects/${id}/realtime-token`),

  compile: (id: string, options: CompileOptions = {}) =>
    request<CompileResult>('POST', `/projects/${id}/compile`, { options }),
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
