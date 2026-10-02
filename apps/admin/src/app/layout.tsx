import { frFR } from '@clerk/localizations'
import { ClerkProvider } from '@clerk/nextjs'
import type { Metadata } from 'next'
import type { ReactNode } from 'react'
import { ClerkApiBridge } from '@/components/clerk-api-bridge'
import { serverEnv } from '@/env'
import './globals.css'

export const metadata: Metadata = {
  title: 'Kaxolax · Admin',
  robots: { index: false, follow: false },
}

// Clé Clerk lue à chaque requête (même image pour tous les environnements) : rien n'est pré-rendu.
export const dynamic = 'force-dynamic'

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <ClerkProvider
      publishableKey={serverEnv.CLERK_PUBLISHABLE_KEY}
      localization={frFR}
      signInUrl="/sign-in"
      afterSignOutUrl="/sign-in"
      telemetry={false}
      appearance={{
        variables: {
          colorPrimary: 'oklch(0.68 0.13 160)',
          colorBackground: 'oklch(0.2 0.006 260)',
          colorForeground: 'oklch(0.96 0 0)',
          colorMutedForeground: 'oklch(0.7 0.01 260)',
          colorInput: 'oklch(0.25 0.006 260)',
          colorInputForeground: 'oklch(0.96 0 0)',
          colorPrimaryForeground: 'oklch(0.16 0.005 260)',
          borderRadius: '0.625rem',
          fontFamily: 'inherit',
        },
      }}
    >
      <html lang="fr" className="dark">
        <body className="min-h-screen">
          <ClerkApiBridge />
          {children}
        </body>
      </html>
    </ClerkProvider>
  )
}
