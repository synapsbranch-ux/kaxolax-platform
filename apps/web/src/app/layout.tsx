import { frFR } from '@clerk/localizations'
import { ClerkProvider } from '@clerk/nextjs'
import type { Metadata } from 'next'
import type { ReactNode } from 'react'
import { ClerkApiBridge } from '@/components/auth/clerk-api-bridge'
import { serverEnv } from '@/env'
import './globals.css'

export const metadata: Metadata = {
  title: 'Kaxolax',
  description: 'Éditeur LaTeX collaboratif',
}

// Clé Clerk lue à chaque requête (même image pour tous les environnements) : rien n'est pré-rendu.
export const dynamic = 'force-dynamic'

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <ClerkProvider
      publishableKey={serverEnv.CLERK_PUBLISHABLE_KEY}
      localization={frFR}
      signInUrl="/sign-in"
      signUpUrl="/sign-up"
      afterSignOutUrl="/sign-in"
      telemetry={false}
      appearance={{
        variables: {
          colorPrimary: 'oklch(0.42 0.12 160)',
          borderRadius: '0.625rem',
          fontFamily: 'inherit',
        },
      }}
    >
      <html lang="fr">
        <body className="min-h-screen">
          <ClerkApiBridge />
          {children}
        </body>
      </html>
    </ClerkProvider>
  )
}
