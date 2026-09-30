import { MIN_INTERNAL_TOKEN_LENGTH } from '@kaxolax/contracts'
import { z } from 'zod'

/** `agent-1=http://10.0.1.10:3200,agent-2=http://10.0.1.11:3200` */
const agentsSchema = z
  .string()
  .min(1)
  .transform((value, ctx) => {
    const agents = new Map<string, string>()
    for (const pair of value
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean)) {
      const separator = pair.indexOf('=')
      const id = pair.slice(0, separator).trim()
      const url = URL.parse(pair.slice(separator + 1).trim())
      if (
        separator <= 0 ||
        url === null ||
        !['http:', 'https:'].includes(url.protocol) ||
        agents.has(id)
      ) {
        ctx.addIssue({
          code: 'custom',
          message: `Invalid agent entry: ${pair} (expected id=http://host:port)`,
        })
        return z.NEVER
      }
      agents.set(id, url.toString().replace(/\/$/, ''))
    }
    return agents
  })

/** Configuration du gateway, lue dans l'environnement et validée au démarrage. */
export const configSchema = z.object({
  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().int().min(0).max(65_535).default(3100),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  INTERNAL_TOKEN: z.string().min(MIN_INTERNAL_TOKEN_LENGTH),
  REDIS_URL: z.string().min(1),
  /** À l'étape 1, la liste des agents est statique. */
  COMPILE_AGENTS: agentsSchema,
  /** Un agent qui ne répond pas à /health dans ce délai est considéré comme indisponible. */
  AGENT_HEALTH_TIMEOUT_MS: z.coerce.number().int().positive().default(1_000),
  /** Affinité projet → agent : même agent = répertoire déjà présent = compilation incrémentale. */
  AFFINITY_TTL_SECONDS: z.coerce
    .number()
    .int()
    .positive()
    .default(24 * 60 * 60),
})

export type GatewayConfig = z.infer<typeof configSchema>

export function loadConfig(env: NodeJS.ProcessEnv = process.env): GatewayConfig {
  const parsed = configSchema.safeParse(env)
  if (!parsed.success) {
    const problems = parsed.error.issues.map(
      (issue) => `  ${issue.path.join('.')}: ${issue.message}`,
    )
    throw new Error(`Invalid compile-gateway configuration:\n${problems.join('\n')}`)
  }
  return parsed.data
}
