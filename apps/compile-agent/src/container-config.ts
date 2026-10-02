import { hostname } from 'node:os'
import { resolve } from 'node:path'
import { MIN_INTERNAL_TOKEN_LENGTH } from '@kaxolax/contracts'
import { z } from 'zod'

const GIB = 1024 * 1024 * 1024
const absolutePath = z
  .string()
  .min(1)
  .transform((path) => resolve(path))

/**
 * Configuration de l'agent dans le conteneur Cloudflare (une VM par projet, sans réseau). Le
 * Worker la fournit au démarrage (`envVars` du Durable Object), jeton interne compris.
 */
export const containerConfigSchema = z.object({
  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().int().min(1).max(65_535).default(8080),
  AGENT_ID: z.string().min(1).default(hostname()),
  /** Jeton tiré au hasard par le Durable Object : seul le Worker parle au conteneur. */
  INTERNAL_TOKEN: z.string().min(MIN_INTERNAL_TOKEN_LENGTH),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  /** Nom du bucket R2 des sorties, tel que l'API l'écrit dans chaque demande. */
  OUTPUT_BUCKET: z.string().min(3),
  COMPILES_DIR: absolutePath.default(resolve('/srv/kaxolax/compiles')),
  CACHE_DIR: absolutePath.default(resolve('/srv/kaxolax/cache')),
  /** Sorties d'une compilation, gardées jusqu'à leur copie dans R2 par le Worker. */
  OUTPUTS_DIR: absolutePath.default(resolve('/srv/kaxolax/outputs')),
  WORKDIR_MAX_BYTES: z.coerce
    .number()
    .int()
    .positive()
    .default(2 * GIB),
  CACHE_MAX_BYTES: z.coerce
    .number()
    .int()
    .positive()
    .default(4 * GIB),
  SANDBOX_UID: z.coerce.number().int().positive().default(1000),
  SANDBOX_GID: z.coerce.number().int().positive().default(1000),
  SANDBOX_TMP_DIR: absolutePath.default(resolve('/tmp')),
  /** PATH des compilations : celui de l'image TeX Live. */
  SANDBOX_PATH: z
    .string()
    .min(1)
    .default(
      '/opt/kaxolax/bin:/usr/local/texlive/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
    ),
  /** Variables de l'image transmises aux compilations (jamais un secret). */
  SANDBOX_ENV_PASSTHROUGH: z
    .string()
    .default('KAXOLAX_TEXLIVE_YEAR,KAXOLAX_TEXLIVE_SCHEME')
    .transform((names) =>
      names
        .split(',')
        .map((name) => name.trim())
        .filter(Boolean),
    ),
})

export type ContainerConfig = z.infer<typeof containerConfigSchema>

export function loadContainerConfig(env: NodeJS.ProcessEnv = process.env): ContainerConfig {
  const parsed = containerConfigSchema.safeParse(env)
  if (!parsed.success) {
    const problems = parsed.error.issues.map(
      (issue) => `  ${issue.path.join('.')}: ${issue.message}`,
    )
    throw new Error(`Invalid compile container configuration:\n${problems.join('\n')}`)
  }
  return parsed.data
}
