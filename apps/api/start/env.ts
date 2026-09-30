/*
|--------------------------------------------------------------------------
| Variables d'environnement, validées au démarrage
|--------------------------------------------------------------------------
*/
import { Env } from '@adonisjs/core/env'

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
})
