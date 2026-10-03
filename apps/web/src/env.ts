import { z } from 'zod'

/** Variable facultative ; une valeur vide (fichier .env d'exemple) compte comme absente. */
const optional = <T extends z.ZodType>(type: T) =>
  z.preprocess((value) => (value === '' ? undefined : value), type.optional())

const httpUrl = z.url({ protocol: /^https?$/ })

/** Pile locale (docker compose) : origines par défaut hors production seulement. */
export const LOCAL_REALTIME_URL = 'ws://localhost:1234'
export const LOCAL_STORAGE_URL = 'http://localhost:8333'

/** Variables d'environnement du serveur Next.js, validées au chargement (dev, build et start). */
const schema = z.object({
  NODE_ENV: optional(z.string()),
  /** URL de l'API vue par le serveur Next.js (réécritures /api en local). */
  API_INTERNAL_URL: z.url().default('http://127.0.0.1:3333'),
  /**
   * Clerk, lu à l'exécution (et non figé au build) : la même image sert tous les environnements.
   * Optionnelles au build ; sans elles, les pages répondent une erreur de configuration.
   */
  CLERK_PUBLISHABLE_KEY: optional(z.string().startsWith('pk_')),
  CLERK_SECRET_KEY: optional(z.string().startsWith('sk_')),
  /** Clé publique PEM, sur une ligne avec des \n : vérification des sessions sans réseau. */
  CLERK_JWT_KEY: optional(z.string().transform((value) => value.replaceAll('\\n', '\n').trim())),
  /**
   * Origines autorisées par la CSP des pages (`src/lib/security-headers.ts`), mêmes valeurs que
   * dans apps/api : service temps réel (WebSocket), stockage S3/R2 des URL présignées (PDF,
   * fichiers, envois), fichiers publics des templates. En production, celles qui manquent sont
   * lues sur l'API (`src/lib/csp-sources.ts`) ; ailleurs, défauts de la pile locale.
   */
  REALTIME_PUBLIC_URL: optional(
    z.string().regex(/^wss?:\/\//, { message: 'Expected a ws:// or wss:// URL' }),
  ),
  S3_PUBLIC_ENDPOINT: optional(httpUrl),
  /** Repli du stockage, comme l'API (`publicEndpoint ?? endpoint`, object_storage.ts). */
  S3_ENDPOINT: optional(httpUrl),
  TEMPLATES_PUBLIC_URL: optional(httpUrl),
  TEMPLATES_CATALOG_URL: optional(httpUrl),
})

/** Configuration résolue du serveur Next.js. */
export interface WebEnv {
  API_INTERNAL_URL: string
  CLERK_PUBLISHABLE_KEY?: string | undefined
  CLERK_SECRET_KEY?: string | undefined
  CLERK_JWT_KEY?: string | undefined
  /** URL publique du temps réel ; absente en production sans la variable (lue sur l'API). */
  REALTIME_PUBLIC_URL: string | undefined
  /** Origine des URL présignées : `S3_PUBLIC_ENDPOINT`, sinon `S3_ENDPOINT` (comme l'API). */
  STORAGE_PUBLIC_URL: string | undefined
  TEMPLATES_PUBLIC_URL?: string | undefined
  TEMPLATES_CATALOG_URL?: string | undefined
}

function invalid(issues: readonly { path: readonly PropertyKey[]; message: string }[]): Error {
  const problems = issues.map((issue) => `  ${issue.path.map(String).join('.')}: ${issue.message}`)
  return new Error(`Invalid web configuration:\n${problems.join('\n')}`)
}

/**
 * Lit la configuration du serveur Next.js. Les origines de la pile locale ne servent de défaut
 * qu'hors production : en production, une origine absente reste absente (lue alors sur l'API,
 * `src/lib/csp-sources.ts`) ; `next build` charge aussi ce module avec NODE_ENV=production.
 */
export function parseWebEnv(env: Record<string, string | undefined>): WebEnv {
  const parsed = schema.safeParse(env)
  if (!parsed.success) throw invalid(parsed.error.issues)
  const { NODE_ENV, S3_PUBLIC_ENDPOINT, S3_ENDPOINT, ...rest } = parsed.data
  const local = NODE_ENV !== 'production'
  return {
    ...rest,
    REALTIME_PUBLIC_URL: rest.REALTIME_PUBLIC_URL ?? (local ? LOCAL_REALTIME_URL : undefined),
    STORAGE_PUBLIC_URL:
      S3_PUBLIC_ENDPOINT ?? S3_ENDPOINT ?? (local ? LOCAL_STORAGE_URL : undefined),
  }
}

/**
 * Origines de la CSP absentes des variables du serveur de production. Elles sont alors lues sur
 * l'API (`GET /api/v1/client-config`, `src/lib/csp-sources.ts`), qui les a toujours : le service
 * web démarre sans elles, et `src/instrumentation.ts` le signale au démarrage.
 */
export function missingCspOrigins(env: Record<string, string | undefined>): string[] {
  const config = parseWebEnv(env)
  if (env.NODE_ENV !== 'production') return []
  const missing: string[] = []
  if (config.REALTIME_PUBLIC_URL === undefined) missing.push('REALTIME_PUBLIC_URL')
  if (config.STORAGE_PUBLIC_URL === undefined) missing.push('S3_PUBLIC_ENDPOINT')
  if (config.TEMPLATES_PUBLIC_URL === undefined && config.TEMPLATES_CATALOG_URL === undefined) {
    missing.push('TEMPLATES_PUBLIC_URL')
  }
  return missing
}

export const serverEnv = parseWebEnv(process.env)
