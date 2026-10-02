import { MIN_INTERNAL_TOKEN_LENGTH } from '@kaxolax/contracts'
import { z } from 'zod'

/** Configuration du service temps réel, lue dans l'environnement et validée au démarrage. */
export const configSchema = z.object({
  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().int().min(0).max(65_535).default(1234),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  /** Secret partagé avec l'API, qui signe les jetons de connexion. */
  REALTIME_TOKEN_SECRET: z.string().min(32),
  /** Secret partagé entre services internes (routes /internal). */
  INTERNAL_TOKEN: z.string().min(MIN_INTERNAL_TOKEN_LENGTH),
  DATABASE_URL: z.string().min(1),
  DB_SSL: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
  /** Écriture en base regroupée : au plus tard STORE_MAX_DEBOUNCE_MS après la première modification. */
  STORE_DEBOUNCE_MS: z.coerce.number().int().nonnegative().default(2_000),
  STORE_MAX_DEBOUNCE_MS: z.coerce.number().int().nonnegative().default(10_000),
  /** Une mise à jour d'un rédacteur fait relire son rôle en base si la dernière lecture est plus ancienne. */
  ROLE_RECHECK_MS: z.coerce.number().int().nonnegative().default(5_000),
  /** Relecture périodique du rôle de toutes les connexions (0 : désactivée). */
  ROLE_SWEEP_MS: z.coerce.number().int().nonnegative().default(30_000),
})

export type RealtimeConfig = z.infer<typeof configSchema>

export function loadConfig(env: NodeJS.ProcessEnv = process.env): RealtimeConfig {
  const parsed = configSchema.safeParse(env)
  if (!parsed.success) {
    const problems = parsed.error.issues.map(
      (issue) => `  ${issue.path.join('.')}: ${issue.message}`,
    )
    throw new Error(`Invalid realtime configuration:\n${problems.join('\n')}`)
  }
  return parsed.data
}
