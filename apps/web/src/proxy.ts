import { clerkMiddleware } from '@clerk/nextjs/server'
import { serverEnv } from '@/env'
import { createCspSourcesResolver, fetchClientConfig } from '@/lib/csp-sources'
import { webContentSecurityPolicy } from '@/lib/security-headers'

/**
 * Origines de la CSP : variables du serveur web, complétées au besoin par la configuration de
 * l'API (`src/lib/csp-sources.ts`). Une seule lecture partagée par toutes les requêtes.
 */
const cspSources = createCspSourcesResolver({
  env: serverEnv,
  fetchConfig: () => fetchClientConfig(serverEnv.API_INTERNAL_URL),
})

/**
 * Prépare l'état d'authentification Clerk de chaque requête (session vérifiée sans réseau) et pose
 * la CSP de chaque page (nonce par requête, `src/lib/security-headers.ts`). La protection des
 * pages est faite par le layout du groupe (app), pas par motif d'URL.
 */
// CLERK_SECRET_KEY est lue par Clerk dans l'environnement d'exécution (la passer en option exigerait
// une clé de chiffrement de plus).
export default clerkMiddleware(
  () => undefined,
  async () => ({
    publishableKey: serverEnv.CLERK_PUBLISHABLE_KEY,
    jwtKey: serverEnv.CLERK_JWT_KEY,
    signInUrl: '/sign-in',
    signUpUrl: '/sign-up',
    contentSecurityPolicy: webContentSecurityPolicy(await cspSources()),
  }),
)

export const config = {
  // /api est réécrit vers l'API AdonisJS, qui vérifie elle-même le jeton. Exclus aussi : fichiers
  // statiques et /healthz (la sonde ne dépend pas de la configuration Clerk).
  matcher: ['/((?!_next|api/|healthz$|.*\\.[\\w]+$).*)'],
}
