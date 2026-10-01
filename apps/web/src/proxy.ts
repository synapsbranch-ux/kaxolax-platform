import { clerkMiddleware } from '@clerk/nextjs/server'
import { serverEnv } from '@/env'

/**
 * Prépare l'état d'authentification Clerk de chaque requête (session vérifiée sans réseau). La
 * protection des pages est faite par le layout du groupe (app), pas par motif d'URL.
 */
// CLERK_SECRET_KEY est lue par Clerk dans l'environnement d'exécution (la passer en option exigerait
// une clé de chiffrement de plus).
export default clerkMiddleware({
  publishableKey: serverEnv.CLERK_PUBLISHABLE_KEY,
  jwtKey: serverEnv.CLERK_JWT_KEY,
  signInUrl: '/sign-in',
  signUpUrl: '/sign-up',
})

export const config = {
  // /api est réécrit vers l'API AdonisJS, qui vérifie elle-même le jeton. Exclus aussi : fichiers
  // statiques et /healthz (la sonde ne dépend pas de la configuration Clerk).
  matcher: ['/((?!_next|api/|healthz$|.*\\.[\\w]+$).*)'],
}
