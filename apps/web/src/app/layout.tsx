import { frFR } from '@clerk/localizations'
import { ClerkProvider } from '@clerk/nextjs'
import { ThemeScript, TooltipProvider } from '@kaxolax/ui'
import type { Metadata } from 'next'
import { cookies, headers } from 'next/headers'
import type { ReactNode } from 'react'
import { ClerkApiBridge } from '@/components/auth/clerk-api-bridge'
import { clerkAppearance } from '@/components/auth/clerk-appearance'
import { serverEnv } from '@/env'
import { parseThemeCookie, THEME_COOKIE } from '@/lib/theme'
// Polices proposées dans les paramètres de l'éditeur (EDITOR_FONTS), servies par l'application :
// seules les déclarations @font-face sont chargées ici, le navigateur ne télécharge un fichier
// de police que lorsqu'elle est réellement utilisée (et seulement les sous-ensembles nécessaires).
import '@fontsource/fira-code/400.css'
import '@fontsource/ibm-plex-mono/400.css'
import '@fontsource/jetbrains-mono/400.css'
import '@fontsource/source-code-pro/400.css'
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
  // Nonce de la CSP de la requête (posée par le proxy) : scripts de Clerk et du thème. Next.js
  // l'applique lui-même à ses propres scripts.
  const nonce = (await headers()).get('x-nonce') ?? undefined
  return (
    <ClerkProvider
      nonce={nonce}
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
          <ThemeScript nonce={nonce} />
        </head>
        <body className="min-h-screen">
          <ClerkApiBridge />
          <TooltipProvider>{children}</TooltipProvider>
        </body>
      </html>
    </ClerkProvider>
  )
}
