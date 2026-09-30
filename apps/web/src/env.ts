import { z } from 'zod'

/** Variables d'environnement du serveur Next.js, validées au démarrage (dev, build et start). */
const schema = z.object({
  /** URL de l'API vue par le serveur Next.js (réécritures /api en local). */
  API_INTERNAL_URL: z.url().default('http://127.0.0.1:3333'),
})

const parsed = schema.safeParse(process.env)
if (!parsed.success) {
  const problems = parsed.error.issues.map((issue) => `  ${issue.path.join('.')}: ${issue.message}`)
  throw new Error(`Invalid web configuration:\n${problems.join('\n')}`)
}

export const serverEnv = parsed.data
