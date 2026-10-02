import {
  type TemplateSummary,
  templateListResponseSchema,
  templateResponseSchema,
} from '@kaxolax/contracts'
import { serverEnv } from '@/env'

/**
 * Lecture de la galerie par le serveur Next.js (rendu des pages publiques, indexables), depuis
 * l'API sur le réseau interne. Une erreur renvoie `unavailable` : la page se rend quand même et le
 * navigateur réessaie.
 */
async function getJson(path: string): Promise<{ status: number; body: unknown }> {
  const response = await fetch(`${serverEnv.API_INTERNAL_URL}/api/v1${path}`, {
    headers: { accept: 'application/json' },
    cache: 'no-store',
    signal: AbortSignal.timeout(10_000),
  })
  return { status: response.status, body: response.ok ? await response.json() : null }
}

export async function fetchTemplates(): Promise<TemplateSummary[] | null> {
  try {
    const { body } = await getJson('/templates')
    const parsed = templateListResponseSchema.safeParse(body)
    return parsed.success ? parsed.data.templates : null
  } catch {
    return null
  }
}

/** Fiche d'un template : `not-found` sur 404, `unavailable` si l'API ne répond pas. */
export async function fetchTemplate(
  id: string,
): Promise<TemplateSummary | 'not-found' | 'unavailable'> {
  try {
    const { status, body } = await getJson(`/templates/${encodeURIComponent(id)}`)
    if (status === 404) return 'not-found'
    const parsed = templateResponseSchema.safeParse(body)
    return parsed.success ? parsed.data.template : 'unavailable'
  } catch {
    return 'unavailable'
  }
}
