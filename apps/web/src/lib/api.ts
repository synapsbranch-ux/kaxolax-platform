import type {
  CodePosition,
  Compiler,
  CompileResult,
  PdfPosition,
  ProjectRole,
  RealtimeTokenResponse,
} from '@kaxolax/contracts'

/** Erreur renvoyée par l'API : statut HTTP, code (`E_…`) et erreurs de validation éventuelles. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | undefined,
    message: string,
    readonly fieldErrors: { field: string; message: string }[] = [],
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

export interface User {
  id: string
  email: string
  fullName: string | null
  emailVerifiedAt: string | null
}

export interface Project {
  id: string
  name: string
  compiler: Compiler
  mainDocumentId: string | null
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

/** Jeton CSRF posé par l'API (Shield) dans un cookie lisible, renvoyé dans X-XSRF-TOKEN. */
export function xsrfToken(cookies: string): string | null {
  for (const cookie of cookies.split(';')) {
    const [name, ...value] = cookie.trim().split('=')
    if (name === 'XSRF-TOKEN') return decodeURIComponent(value.join('='))
  }
  return null
}

function errorFrom(status: number, body: unknown): ApiError {
  const data = (typeof body === 'object' && body !== null ? body : {}) as {
    code?: string
    message?: string
    errors?: { field: string; message: string }[]
  }
  const fieldErrors = Array.isArray(data.errors) ? data.errors : []
  const message = fieldErrors[0]?.message ?? data.message ?? `Request failed (${String(status)})`
  return new ApiError(status, data.code, message, fieldErrors)
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const mutation = method !== 'GET'
  // Le cookie XSRF-TOKEN est posé par la première réponse de l'API.
  if (mutation && xsrfToken(document.cookie) === null)
    await fetch('/api/v1/health', { credentials: 'same-origin' })
  const headers: Record<string, string> = { accept: 'application/json' }
  if (body !== undefined) headers['content-type'] = 'application/json'
  const token = mutation ? xsrfToken(document.cookie) : null
  if (token !== null) headers['x-xsrf-token'] = token
  const response = await fetch(`/api/v1${path}`, {
    method,
    headers,
    credentials: 'same-origin',
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await response.text()
  const data: unknown = text === '' ? null : JSON.parse(text)
  if (!response.ok) throw errorFrom(response.status, data)
  return data as T
}

/** Appels de l'API REST (même origine, cookie de session httpOnly). */
export const api = {
  me: () => request<{ user: User }>('GET', '/auth/me'),
  register: (input: { email: string; password: string; fullName?: string }) =>
    request<{ user: User }>('POST', '/auth/register', input),
  login: (input: { email: string; password: string }) =>
    request<{ user: User }>('POST', '/auth/login', input),
  logout: () => request<null>('POST', '/auth/logout'),
  verifyEmail: (token: string) => request<{ user: User }>('POST', '/auth/verify-email', { token }),
  resendVerification: (email: string) =>
    request<null>('POST', '/auth/resend-verification', { email }),
  forgotPassword: (email: string) => request<null>('POST', '/auth/forgot-password', { email }),
  resetPassword: (token: string, password: string) =>
    request<null>('POST', '/auth/reset-password', { token, password }),

  projects: (view: ProjectView, q: string) =>
    request<{ projects: Project[] }>(
      'GET',
      `/projects?${new URLSearchParams({ view, ...(q.trim() === '' ? {} : { q: q.trim() }) }).toString()}`,
    ),
  project: (id: string) => request<{ project: Project }>('GET', `/projects/${id}`),
  createProject: (name: string) => request<{ project: Project }>('POST', '/projects', { name }),
  updateProject: (
    id: string,
    changes: { name?: string; compiler?: Compiler; mainDocumentId?: string },
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
  completeImport: (uploadId: string) =>
    request<{ project: Project }>('POST', `/imports/${uploadId}/complete`),

  realtimeToken: (id: string) =>
    request<RealtimeTokenResponse>('POST', `/projects/${id}/realtime-token`),

  compile: (id: string) => request<CompileResult>('POST', `/projects/${id}/compile`),
  stopCompile: (id: string) =>
    request<{ stopped: boolean }>('POST', `/projects/${id}/compile/stop`),
  lastCompile: (id: string) =>
    request<{ compile: CompileResult | null }>('GET', `/projects/${id}/compile/last`),
  clearCache: (id: string) =>
    request<{ cleared: boolean }>('POST', `/projects/${id}/compile/clear-cache`),
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

export async function importZip(file: File): Promise<Project> {
  const started = await api.startImport({ filename: file.name, sizeBytes: file.size })
  const put = await fetch(started.url, { method: 'PUT', body: file })
  if (!put.ok) throw new ApiError(put.status, 'E_UPLOAD_FAILED', `Upload of ${file.name} failed`)
  return (await api.completeImport(started.uploadId)).project
}

/** Valeur texte d'un champ de formulaire (chaîne vide si absent). */
export function formValue(form: FormData, name: string): string {
  const value = form.get(name)
  return typeof value === 'string' ? value : ''
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
