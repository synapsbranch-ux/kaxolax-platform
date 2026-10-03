import { missingCspOrigins } from '@/env'

/**
 * Contrôle de la configuration au démarrage du serveur Next.js. Une valeur invalide arrête le
 * processus (Next.js ne fait que journaliser une erreur de `register()`), pour que le déploiement
 * échoue visiblement. Une origine de la CSP absente n'arrête rien : elle est lue sur l'API
 * (`src/lib/csp-sources.ts`) ; l'avertissement invite à la donner aussi au service web.
 */
export function checkStartupEnv(): void {
  let missing: string[]
  try {
    missing = missingCspOrigins(process.env)
  } catch (error) {
    console.error(error instanceof Error ? error.message : error)
    process.exit(1)
    return
  }
  if (missing.length > 0) {
    console.warn(
      `CSP origins not set on the web service (${missing.join(', ')}): read from the API (GET /api/v1/client-config)`,
    )
  }
}
