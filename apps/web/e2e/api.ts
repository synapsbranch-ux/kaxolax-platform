import { clerk } from '@clerk/testing/playwright'
import type { Page } from '@playwright/test'

/** Réponse brute d'un appel de l'API : statut HTTP et corps JSON (null si vide). */
export interface ApiResponse {
  status: number
  body: unknown
}

/** Appel de l'API refusé (statut ≥ 400), avec le corps reçu (`code` `E_…`). */
export class ApiCallError extends Error {
  constructor(
    readonly status: number,
    readonly body: unknown,
    message: string,
  ) {
    super(message)
    this.name = 'ApiCallError'
  }

  get code(): string | null {
    const body = this.body as { code?: unknown } | null
    return typeof body?.code === 'string' ? body.code : null
  }
}

/**
 * Appelle l'API depuis la page, comme `lib/api.ts` : même origine (`/api/v1`), jeton de session
 * Clerk de la page dans `Authorization`. La page doit être sur l'application ; Clerk est attendu.
 * Sert à préparer ou nettoyer un parcours quand l'écran correspondant n'est pas ce qui est testé.
 */
export async function rawApi(
  page: Page,
  method: string,
  path: string,
  body?: unknown,
): Promise<ApiResponse> {
  await clerk.loaded({ page })
  return page.evaluate(
    async ({ method, path, json }) => {
      const token = (await window.Clerk.session?.getToken()) ?? null
      const headers: Record<string, string> = { accept: 'application/json' }
      if (json !== null) headers['content-type'] = 'application/json'
      if (token !== null) headers.authorization = `Bearer ${token}`
      const response = await fetch(`/api/v1${path}`, {
        method,
        headers,
        credentials: 'omit',
        body: json ?? undefined,
      })
      const text = await response.text()
      return { status: response.status, body: text === '' ? null : (JSON.parse(text) as unknown) }
    },
    { method, path, json: body === undefined ? null : JSON.stringify(body) },
  )
}

/** Appel de l'API qui doit réussir ; sinon `ApiCallError`. */
export async function api<T>(page: Page, method: string, path: string, body?: unknown): Promise<T> {
  const response = await rawApi(page, method, path, body)
  if (response.status >= 400) {
    throw new ApiCallError(
      response.status,
      response.body,
      `${method} ${path} answered ${String(response.status)}: ${JSON.stringify(response.body)}`,
    )
  }
  return response.body as T
}

/** Compte de l'API (`GET /me`). */
export interface ApiUser {
  id: string
  email: string
  fullName: string | null
  avatarUrl: string | null
}

/** Projet tel que le liste l'API (`GET /projects`). */
export interface ApiProject {
  id: string
  name: string
  role: 'owner' | 'editor' | 'reviewer' | 'viewer'
  trashedAt: string | null
}

/** Supprime définitivement les projets dont le compte de la page est propriétaire. */
export async function deleteOwnedProjects(page: Page): Promise<void> {
  for (const view of ['active', 'archived', 'trashed'] as const) {
    const { projects } = await api<{ projects: ApiProject[] }>(
      page,
      'GET',
      `/projects?view=${view}`,
    )
    for (const project of projects.filter((candidate) => candidate.role === 'owner')) {
      if (view !== 'trashed') await api(page, 'POST', `/projects/${project.id}/trash`)
      await api(page, 'DELETE', `/projects/${project.id}`)
    }
  }
}
