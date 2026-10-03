import { type ClientConfig, clientConfigSchema } from '@kaxolax/contracts'
import type { WebEnv } from '@/env'
import type { WebCspSources } from '@/lib/security-headers'

/** Durée pendant laquelle la configuration lue sur l'API est servie sans la redemander. */
const FRESH_MS = 5 * 60_000
/** Après un échec, délai avant un nouvel essai (la CSP reste alors celle des variables). */
const RETRY_MS = 30_000
/** Une requête de page n'attend jamais l'API plus longtemps. */
const TIMEOUT_MS = 2_000

/** Lit `GET /api/v1/client-config` sur l'API (réseau interne). */
export async function fetchClientConfig(apiInternalUrl: string): Promise<ClientConfig> {
  const response = await fetch(`${apiInternalUrl}/api/v1/client-config`, {
    cache: 'no-store',
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
  if (!response.ok) throw new Error(`client-config: HTTP ${String(response.status)}`)
  return clientConfigSchema.parse(await response.json())
}

interface ResolverOptions {
  env: Pick<
    WebEnv,
    'REALTIME_PUBLIC_URL' | 'STORAGE_PUBLIC_URL' | 'TEMPLATES_PUBLIC_URL' | 'TEMPLATES_CATALOG_URL'
  >
  fetchConfig: () => Promise<ClientConfig>
  now?: () => number
  onError?: (error: unknown) => void
}

/**
 * Origines de la CSP des pages. Les variables du serveur web passent en premier ; celles qui
 * manquent (production sans `REALTIME_PUBLIC_URL`, `S3_PUBLIC_ENDPOINT` ou `TEMPLATES_*` sur le
 * service web) sont lues sur l'API, qui les a toujours. La réponse est gardée `FRESH_MS`, puis
 * relue en arrière-plan ; l'API injoignable n'arrête rien : la CSP garde la dernière réponse
 * reçue, ou à défaut les seules variables, et un nouvel essai a lieu après `RETRY_MS`.
 */
export function createCspSourcesResolver(options: ResolverOptions): () => Promise<WebCspSources> {
  const { env, fetchConfig } = options
  const now = options.now ?? Date.now
  const onError =
    options.onError ??
    ((error: unknown) => {
      console.error('CSP origins: cannot read /api/v1/client-config from the API', error)
    })
  const fromEnv: WebCspSources = {
    realtimeUrl: env.REALTIME_PUBLIC_URL,
    storageUrl: env.STORAGE_PUBLIC_URL,
    templateUrls: [env.TEMPLATES_PUBLIC_URL, env.TEMPLATES_CATALOG_URL],
  }
  const complete =
    env.REALTIME_PUBLIC_URL !== undefined &&
    env.STORAGE_PUBLIC_URL !== undefined &&
    (env.TEMPLATES_PUBLIC_URL !== undefined || env.TEMPLATES_CATALOG_URL !== undefined)

  let remote: ClientConfig | null = null
  let nextFetchAt = 0
  let pending: Promise<void> | null = null

  const merged = (): WebCspSources =>
    remote === null
      ? fromEnv
      : {
          realtimeUrl: env.REALTIME_PUBLIC_URL ?? remote.realtimeUrl,
          storageUrl: env.STORAGE_PUBLIC_URL ?? remote.storageUrl ?? undefined,
          templateUrls: [...(fromEnv.templateUrls ?? []), ...remote.templateUrls],
        }

  const refresh = (): Promise<void> => {
    pending ??= fetchConfig()
      .then(
        (config) => {
          remote = config
          nextFetchAt = now() + FRESH_MS
        },
        (error: unknown) => {
          nextFetchAt = now() + RETRY_MS
          onError(error)
        },
      )
      .finally(() => {
        pending = null
      })
    return pending
  }

  return async () => {
    if (complete) return fromEnv
    if (now() >= nextFetchAt) {
      const running = refresh()
      // Première lecture : la page attend la réponse (bornée par le délai de fetchClientConfig).
      // Ensuite, la relecture se fait en arrière-plan sur la dernière réponse reçue.
      if (remote === null) await running
    }
    return merged()
  }
}
