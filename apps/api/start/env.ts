/*
|--------------------------------------------------------------------------
| Variables d'environnement, validées au démarrage
|--------------------------------------------------------------------------
*/
import { Env } from '@adonisjs/core/env'
import { Secret } from '@adonisjs/core/helpers'
import { MIN_INTERNAL_TOKEN_LENGTH } from '@kaxolax/contracts'

/** Secret partagé entre services : au moins 32 caractères. */
function sharedSecret(key: string, value?: string): Secret<string> {
  if (value === undefined || value.length < MIN_INTERNAL_TOKEN_LENGTH) {
    throw new Error(`Missing environment variable "${key}" (at least 32 characters)`)
  }
  return new Secret(value)
}

/** URL absolue avec l'un des protocoles attendus (ws/wss n'est pas accepté par le format « url »). */
function urlWith(...protocols: string[]) {
  return (key: string, value?: string): string => {
    const url = URL.parse(value ?? '')
    if (url === null || !protocols.includes(url.protocol.slice(0, -1))) {
      throw new Error(
        `Invalid environment variable "${key}": expected a ${protocols.join('/')} URL`,
      )
    }
    return url.toString().replace(/\/$/, '')
  }
}

/** Rend facultative une variable validée par `validate` (absente ou vide : undefined). */
function optional<T>(validate: (key: string, value?: string) => T) {
  return (key: string, value?: string): T | undefined =>
    value === undefined || value === '' ? undefined : validate(key, value)
}

export default await Env.create(new URL('../', import.meta.url), {
  NODE_ENV: Env.schema.enum(['development', 'production', 'test'] as const),
  PORT: Env.schema.number(),
  HOST: Env.schema.string({ format: 'host' }),
  LOG_LEVEL: Env.schema.enum([
    'fatal',
    'error',
    'warn',
    'info',
    'debug',
    'trace',
    'silent',
  ] as const),

  APP_KEY: Env.schema.secret(),
  /** Origine publique de l'application (claim `azp` des jetons Clerk, liens des emails). */
  APP_URL: Env.schema.string({ format: 'url', tld: false }),
  /** Origine de l'admin (apps/admin, domaine séparé) : ses jetons Clerk sont aussi acceptés. */
  ADMIN_URL: Env.schema.string.optional({ format: 'url', tld: false }),
  /** Nombre de proxys de confiance devant l'API (Next.js en local, CDN en production). */
  TRUSTED_PROXY_HOPS: Env.schema.number.optional(),

  /** Clé publique PEM de l'instance Clerk : vérification des jetons de session sans réseau. */
  CLERK_JWT_KEY: Env.schema.string.optional(),
  /** Clé secrète Clerk (API Backend : vérification de la MFA des admins, actions de l'admin). */
  CLERK_SECRET_KEY: Env.schema.secret.optional(),
  /** Secret de signature des webhooks Clerk (Standard Webhooks). */
  CLERK_WEBHOOK_SIGNING_SECRET: Env.schema.secret.optional(),

  DB_HOST: Env.schema.string({ format: 'host' }),
  DB_PORT: Env.schema.number(),
  DB_USER: Env.schema.string(),
  DB_PASSWORD: Env.schema.secret(),
  DB_DATABASE: Env.schema.string(),
  DB_SSL: Env.schema.boolean.optional(),

  SMTP_HOST: Env.schema.string({ format: 'host' }),
  SMTP_PORT: Env.schema.number(),
  SMTP_USERNAME: Env.schema.string.optional(),
  SMTP_PASSWORD: Env.schema.secret.optional(),
  SMTP_SECURE: Env.schema.boolean.optional(),
  MAIL_FROM_ADDRESS: Env.schema.string({ format: 'email' }),
  MAIL_FROM_NAME: Env.schema.string(),

  /** S3 : SeaweedFS en local, AWS en staging (sans endpoint ni clés : rôle de l'instance). */
  S3_REGION: Env.schema.string(),
  S3_ENDPOINT: Env.schema.string.optional({ format: 'url', tld: false }),
  /** Endpoint vu par le navigateur pour les URL présignées (localhost:8333 en local). */
  S3_PUBLIC_ENDPOINT: Env.schema.string.optional({ format: 'url', tld: false }),
  S3_FORCE_PATH_STYLE: Env.schema.boolean.optional(),
  S3_ACCESS_KEY_ID: Env.schema.string.optional(),
  S3_SECRET_ACCESS_KEY: Env.schema.secret.optional(),
  S3_BUCKET_PROJECT_FILES: Env.schema.string(),
  S3_BUCKET_COMPILE_OUTPUTS: Env.schema.string(),

  /**
   * Index des packages TeX Live (kaxolax-texlive-images, `texlive/<année>/packages.json`) : bucket
   * du stockage objet configuré (S3_*) où la CI le publie, lu avec les mêmes clés. Absent en
   * développement et en test : petite fixture (resources/fixtures/texlive-packages.json).
   */
  TEXLIVE_INDEX_BUCKET: Env.schema.string.optional(),
  /** Clé de l'index dans ce bucket (défaut : texlive/2026/packages.json). */
  TEXLIVE_INDEX_KEY: Env.schema.string.optional(),

  /** Signe les jetons de connexion au service temps réel (même valeur dans apps/realtime). */
  REALTIME_TOKEN_SECRET: sharedSecret,
  /** En-tête X-Internal-Token des appels entre services (même valeur partout). */
  INTERNAL_TOKEN: sharedSecret,
  /** URL WebSocket donnée au navigateur : ws:// en local, wss://…/realtime en staging. */
  REALTIME_PUBLIC_URL: urlWith('ws', 'wss'),
  /** URL HTTP du service temps réel pour les routes /internal. */
  REALTIME_INTERNAL_URL: urlWith('http', 'https'),
  /** `gateway` (synchrone : compile-gateway + agents Docker, défaut) ou `cloudflare` (asynchrone). */
  COMPILE_BACKEND: Env.schema.enum.optional(['gateway', 'cloudflare'] as const),
  /** URL HTTP du compile-gateway (réseau interne), exigée en mode `gateway`. */
  COMPILE_GATEWAY_URL: optional(urlWith('http', 'https')),
  /** URL du Worker de compilation Cloudflare, exigée en mode `cloudflare`. */
  COMPILE_WORKER_URL: optional(urlWith('http', 'https')),
  /** Secret partagé avec le Worker (jetons API → Worker, signature des rappels). */
  COMPILE_WORKER_SECRET: optional(sharedSecret),
  /** Historique : balayage des versions automatiques, en secondes (0 : désactivé ; défaut 30). */
  HISTORY_SWEEP_SECONDS: Env.schema.number.optional(),
  /** Historique : délai avant un nouvel essai de version automatique en échec (défaut 600). */
  HISTORY_RETRY_SECONDS: Env.schema.number.optional(),
  /** Historique : purge des versions expirées, en secondes (0 : désactivée ; défaut 3600). */
  HISTORY_PURGE_SECONDS: Env.schema.number.optional(),

  /**
   * Catalogue public de la galerie (`templates.json` publié par kaxolax-templates sur R2). Absent
   * hors production : catalogue de démonstration local (resources/templates.fixture.json).
   */
  TEMPLATES_CATALOG_URL: optional(urlWith('http', 'https')),
  /** Base des fichiers du catalogue (PDF, miniatures, zip) ; défaut : dossier du catalogue. */
  TEMPLATES_PUBLIC_URL: optional(urlWith('http', 'https')),

  /**
   * Clé de l'API Anthropic (Claude), côté API seulement. Facultative : sans elle, les routes de
   * l'IA répondent 503 `E_AI_UNAVAILABLE` et le reste de l'application fonctionne.
   */
  ANTHROPIC_API_KEY: Env.schema.secret.optional(),
})
