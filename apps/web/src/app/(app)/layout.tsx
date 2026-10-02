import { auth } from '@clerk/nextjs/server'
import type { ReactNode } from 'react'
import { PreferencesProvider } from '@/components/preferences/preferences-provider'
import { SettingsProvider } from '@/components/preferences/settings-provider'
import { SystemBanner } from '@/components/system-banner'

/**
 * Pages de l'application : une session Clerk est exigée (sinon, connexion puis retour ici). Les
 * préférences de l'utilisateur (thème, mise en page, onglets, paramètres de l'éditeur) y sont
 * chargées une fois, avec la boîte des paramètres ; la bannière système s'affiche par-dessus
 * toutes les pages.
 */
export default async function AppLayout({ children }: { children: ReactNode }) {
  const { isAuthenticated, redirectToSignIn } = await auth()
  if (!isAuthenticated) return redirectToSignIn()
  return (
    <PreferencesProvider>
      <SettingsProvider>
        <SystemBanner />
        {children}
      </SettingsProvider>
    </PreferencesProvider>
  )
}
