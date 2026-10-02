import type { Hocuspocus } from '@hocuspocus/server'
import {
  MAX_PROJECT_EVENT_BYTES,
  type ProjectEvent,
  type ProjectEventResponse,
} from '@kaxolax/contracts'

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'

/** POST /internal/projects/:id/events : message sans état diffusé aux connexions du projet. */
export const EVENTS_ROUTE = new RegExp(`^/internal/projects/(${UUID})/events$`)

/**
 * Diffuse un événement (message « stateless » Hocuspocus) sur chaque document ouvert du projet :
 * documents texte, et document meta du projet quand il existera (même préfixe de nom). Un client
 * qui a plusieurs documents ouverts reçoit l'événement plusieurs fois : il dédoublonne par
 * `buildId` et `status`. Renvoie le nombre de documents touchés.
 */
export function broadcastProjectEvent(
  instance: Hocuspocus,
  projectId: string,
  event: ProjectEvent,
): ProjectEventResponse {
  const prefix = `project:${projectId}:`
  const payload = JSON.stringify(event)
  let delivered = 0
  for (const [name, document] of instance.documents) {
    if (!name.startsWith(prefix)) continue
    document.broadcastStateless(payload)
    delivered++
  }
  return { delivered }
}

/** Corps JSON d'une requête interne, limité à `maxBytes` ; null s'il est trop gros ou invalide. */
export async function readJsonBody(
  request: AsyncIterable<unknown>,
  maxBytes = MAX_PROJECT_EVENT_BYTES,
): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))
    size += buffer.byteLength
    if (size > maxBytes) return null
    chunks.push(buffer)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
  } catch {
    return null
  }
}
