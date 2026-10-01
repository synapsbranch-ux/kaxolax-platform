import { auth } from '@clerk/nextjs/server'
import type { ReactNode } from 'react'
import { SystemBanner } from '@/components/system-banner'

/** Pages de l'application : une session Clerk est exigée (sinon, connexion puis retour ici). */
export default async function AppLayout({ children }: { children: ReactNode }) {
  const { isAuthenticated, redirectToSignIn } = await auth()
  if (!isAuthenticated) return redirectToSignIn()
  return (
    <>
      <SystemBanner />
      {children}
    </>
  )
}
