import { clerkMiddleware } from '@clerk/nextjs/server'
import { serverEnv } from '@/env'

/**
 * Prépare l'état d'authentification Clerk de chaque requête (session vérifiée sans réseau). Le
 * contrôle d'accès (session, rôle admin, second facteur) est fait par le layout du groupe
 * (admin), puis revérifié par l'API à chaque appel.
 */
// CLERK_SECRET_KEY est lue par Clerk dans l'environnement d'exécution.
export default clerkMiddleware({
  publishableKey: serverEnv.CLERK_PUBLISHABLE_KEY,
  jwtKey: serverEnv.CLERK_JWT_KEY,
  signInUrl: '/sign-in',
})

export const config = {
  // /api est réécrit vers l'API, qui vérifie elle-même le jeton ; exclus aussi les fichiers
  // statiques et /healthz.
  matcher: ['/((?!_next|api/|healthz$|.*\\.[\\w]+$).*)'],
}
