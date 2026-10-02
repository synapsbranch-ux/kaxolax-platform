import { auth } from '@clerk/nextjs/server'
import type { ReactNode } from 'react'
import { PlanLimitDialog } from '@/components/billing/plan-limit-dialog'
import { PreferencesProvider } from '@/components/preferences/preferences-provider'
import { SystemBanner } from '@/components/system-banner'

/**
 * Pages de l'application : une session Clerk est exigée (sinon, connexion puis retour ici). Les
 * préférences de l'utilisateur (thème, mise en page, onglets) y sont chargées une fois ; la bannière
 * système s'affiche par-dessus toutes les pages, et les refus de limite du plan dans une boîte de
 * dialogue commune.
 */
export default async function AppLayout({ children }: { children: ReactNode }) {
  const { isAuthenticated, redirectToSignIn } = await auth()
  if (!isAuthenticated) return redirectToSignIn()
  return (
    <PreferencesProvider>
      <SystemBanner />
      {children}
      <PlanLimitDialog />
    </PreferencesProvider>
  )
}
