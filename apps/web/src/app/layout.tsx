import { frFR } from '@clerk/localizations'
import { ClerkProvider } from '@clerk/nextjs'
import { ThemeScript, TooltipProvider } from '@kaxolax/ui'
import type { Metadata } from 'next'
import { cookies } from 'next/headers'
import type { ReactNode } from 'react'
import { ClerkApiBridge } from '@/components/auth/clerk-api-bridge'
import { clerkAppearance } from '@/components/auth/clerk-appearance'
import { serverEnv } from '@/env'
import { parseThemeCookie, THEME_COOKIE } from '@/lib/theme'
import './globals.css'

export const metadata: Metadata = {
  title: 'Kaxolax',
  description: 'Éditeur LaTeX collaboratif',
}

// Clé Clerk lue à chaque requête (même image pour tous les environnements) : rien n'est pré-rendu.
export const dynamic = 'force-dynamic'

export default async function RootLayout({ children }: { children: ReactNode }) {
  // Thème mémorisé par le cookie (copie de la préférence) : rendu dès le HTML, sans flash. Sans
  // cookie, ThemeScript lit localStorage, sinon prend le sombre.
  const theme = parseThemeCookie((await cookies()).get(THEME_COOKIE)?.value)
  return (
    <ClerkProvider
      publishableKey={serverEnv.CLERK_PUBLISHABLE_KEY}
      localization={frFR}
      signInUrl="/sign-in"
      signUpUrl="/sign-up"
      afterSignOutUrl="/sign-in"
      telemetry={false}
      appearance={clerkAppearance}
    >
      <html
        lang="fr"
        suppressHydrationWarning
        data-theme={theme ?? undefined}
        data-theme-preference={theme ?? undefined}
        style={theme === null ? undefined : { colorScheme: theme }}
      >
        <head>
          <ThemeScript />
        </head>
        <body className="min-h-screen">
          <ClerkApiBridge />
          <TooltipProvider>{children}</TooltipProvider>
        </body>
      </html>
    </ClerkProvider>
  )
}
