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
  /** Origine publique de l'application (liens des emails). */
  APP_URL: Env.schema.string({ format: 'url', tld: false }),
  /** Nombre de proxys de confiance devant l'API (Next.js en local, CloudFront en staging). */
  TRUSTED_PROXY_HOPS: Env.schema.number.optional(),

  SESSION_DRIVER: Env.schema.enum(['redis', 'memory'] as const),
  LIMITER_STORE: Env.schema.enum(['redis', 'memory'] as const),

  DB_HOST: Env.schema.string({ format: 'host' }),
  DB_PORT: Env.schema.number(),
  DB_USER: Env.schema.string(),
  DB_PASSWORD: Env.schema.secret(),
  DB_DATABASE: Env.schema.string(),
  DB_SSL: Env.schema.boolean.optional(),

  REDIS_HOST: Env.schema.string({ format: 'host' }),
  REDIS_PORT: Env.schema.number(),
  REDIS_PASSWORD: Env.schema.secret.optional(),

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

  /** Signe les jetons de connexion au service temps réel (même valeur dans apps/realtime). */
  REALTIME_TOKEN_SECRET: sharedSecret,
  /** En-tête X-Internal-Token des appels entre services (même valeur partout). */
  INTERNAL_TOKEN: sharedSecret,
  /** URL WebSocket donnée au navigateur : ws:// en local, wss://…/realtime en staging. */
  REALTIME_PUBLIC_URL: urlWith('ws', 'wss'),
  /** URL HTTP du service temps réel pour les routes /internal. */
  REALTIME_INTERNAL_URL: urlWith('http', 'https'),
  /** URL HTTP du compile-gateway (réseau interne). */
  COMPILE_GATEWAY_URL: urlWith('http', 'https'),
})
