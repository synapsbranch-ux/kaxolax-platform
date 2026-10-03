import { z } from 'zod'

/** Variable facultative ; une valeur vide (fichier .env d'exemple) compte comme absente. */
const optional = <T extends z.ZodType>(type: T) =>
  z.preprocess((value) => (value === '' ? undefined : value), type.optional())

/** Variables d'environnement du serveur Next.js, validées au démarrage (dev, build et start). */
const schema = z.object({
  /** URL de l'API vue par le serveur Next.js (réécritures /api, figées par `next build`). */
  API_INTERNAL_URL: z.url().default('http://127.0.0.1:3333'),
  /**
   * Clerk, lu à l'exécution (et non figé au build) : la même image sert tous les environnements.
   * Optionnelles au build ; sans elles, les pages répondent une erreur de configuration.
   */
  CLERK_PUBLISHABLE_KEY: optional(z.string().startsWith('pk_')),
  CLERK_SECRET_KEY: optional(z.string().startsWith('sk_')),
  /** Clé publique PEM, sur une ligne avec des \n : vérification des sessions sans réseau. */
  CLERK_JWT_KEY: optional(z.string().transform((value) => value.replaceAll('\\n', '\n').trim())),
})

const parsed = schema.safeParse(process.env)
if (!parsed.success) {
  const problems = parsed.error.issues.map((issue) => `  ${issue.path.join('.')}: ${issue.message}`)
  throw new Error(`Invalid web configuration:\n${problems.join('\n')}`)
}

export const serverEnv = parsed.data
