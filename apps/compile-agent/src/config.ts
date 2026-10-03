import { hostname } from 'node:os'
import { resolve } from 'node:path'
import { MIN_INTERNAL_TOKEN_LENGTH } from '@kaxolax/contracts'
import { z } from 'zod'

const MIB = 1024 * 1024
const GIB = 1024 * MIB

const booleanString = z
  .enum(['true', 'false', '1', '0'])
  .transform((value) => value === 'true' || value === '1')

/** Configuration de l'agent, lue dans les variables d'environnement et validée au démarrage. */
export const configSchema = z.object({
  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().int().min(1).max(65_535).default(3200),
  AGENT_ID: z.string().min(1).default(hostname()),
  INTERNAL_TOKEN: z.string().min(MIN_INTERNAL_TOKEN_LENGTH),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  COMPILE_IMAGE: z.string().min(1),
  /** runc en local, runsc (gVisor) sur les workers. */
  COMPILE_RUNTIME: z.enum(['runc', 'runsc']).default('runc'),
  DOCKER_SOCKET: z.string().default('/var/run/docker.sock'),
  MAX_CONCURRENT_COMPILES: z.coerce.number().int().min(1).default(2),

  /** Un répertoire par projet (monté dans le conteneur) et l'état de l'agent, hors du montage. */
  COMPILES_DIR: z
    .string()
    .min(1)
    .transform((path) => resolve(path)),
  /** Cache local des fichiers binaires, indexé par sha256. */
  CACHE_DIR: z
    .string()
    .min(1)
    .transform((path) => resolve(path)),
  WORKDIR_MAX_BYTES: z.coerce
    .number()
    .int()
    .positive()
    .default(2 * GIB),
  COMPILES_MAX_BYTES: z.coerce
    .number()
    .int()
    .positive()
    .default(40 * GIB),
  COMPILES_MAX_PROJECTS: z.coerce.number().int().positive().default(500),
  CACHE_MAX_BYTES: z.coerce
    .number()
    .int()
    .positive()
    .default(20 * GIB),

  S3_REGION: z.string().default('us-east-1'),
  /** http://localhost:8333 en local (SeaweedFS) ; vide : point de terminaison AWS par défaut. */
  S3_ENDPOINT: z.url().optional(),
  S3_FORCE_PATH_STYLE: booleanString.default(false),
  /** Vides : identifiants par défaut du SDK (variables AWS_*, rôle d'une instance). */
  S3_ACCESS_KEY_ID: z.string().optional(),
  S3_SECRET_ACCESS_KEY: z.string().optional(),
  S3_BUCKET_PROJECT_FILES: z.string().min(3),
  S3_BUCKET_COMPILE_OUTPUTS: z.string().min(3),
})

export type AgentConfig = z.infer<typeof configSchema>

export const OUTPUT_LIMITS = {
  pdfBytes: 100 * MIB,
  logBytes: 10 * MIB,
  /** Juste au-dessus du plafond du PDF : un fichier tronqué par le noyau le dépasse forcément. */
  fileSizeLimitBytes: 101 * MIB,
} as const

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AgentConfig {
  const parsed = configSchema.safeParse(env)
  if (!parsed.success) {
    const problems = parsed.error.issues.map(
      (issue) => `  ${issue.path.join('.')}: ${issue.message}`,
    )
    throw new Error(`Invalid compile-agent configuration:\n${problems.join('\n')}`)
  }
  return parsed.data
}
