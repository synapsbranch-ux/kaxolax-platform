import { auth } from '@clerk/nextjs/server'
import type { ReactNode } from 'react'
import { AccessDenied } from '@/components/access-denied'
import { AdminShell } from '@/components/admin-shell'
import { hasAdminAccess } from '@/lib/access'

/**
 * Écrans de l'admin : session Clerk exigée (sinon connexion puis retour ici), rôle admin et
 * second facteur vérifié dans la session (claims du jeton). Sinon, refus sans détail. L'API
 * revérifie tout à chaque appel, MFA activée comprise.
 */
export default async function AdminLayout({ children }: { children: ReactNode }) {
  const { isAuthenticated, sessionClaims, redirectToSignIn } = await auth()
  if (!isAuthenticated) return redirectToSignIn()
  if (!hasAdminAccess(sessionClaims)) return <AccessDenied />
  return <AdminShell>{children}</AdminShell>
}
