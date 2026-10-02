import { auth } from '@clerk/nextjs/server'
import type { ReactNode } from 'react'
import { PreferencesProvider } from '@/components/preferences/preferences-provider'

/**
 * Pages de l'application : une session Clerk est exigée (sinon, connexion puis retour ici). Les
 * préférences de l'utilisateur (thème, mise en page, onglets) y sont chargées une fois.
 */
export default async function AppLayout({ children }: { children: ReactNode }) {
  const { isAuthenticated, redirectToSignIn } = await auth()
  if (!isAuthenticated) return redirectToSignIn()
  return <PreferencesProvider>{children}</PreferencesProvider>
}
