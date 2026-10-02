import type { ClerkProvider } from '@clerk/nextjs'
import type { ComponentProps } from 'react'

type Appearance = NonNullable<ComponentProps<typeof ClerkProvider>['appearance']>

/**
 * Habillage des composants Clerk par les jetons de @kaxolax/ui : les variables CSS suivent le
 * thème posé sur <html> (sombre ou clair) sans recharger Clerk ni ajouter de thème Clerk.
 */
export const clerkAppearance: Appearance = {
  variables: {
    colorPrimary: 'var(--primary)',
    colorPrimaryForeground: 'var(--primary-foreground)',
    colorDanger: 'var(--destructive)',
    colorSuccess: 'var(--success)',
    colorBackground: 'var(--card)',
    colorForeground: 'var(--card-foreground)',
    colorMuted: 'var(--muted)',
    colorMutedForeground: 'var(--muted-foreground)',
    colorInput: 'var(--background)',
    colorInputForeground: 'var(--foreground)',
    colorBorder: 'var(--border)',
    colorRing: 'var(--ring)',
    colorNeutral: 'var(--foreground)',
    colorShadow: 'oklch(0 0 0 / 20%)',
    colorModalBackdrop: 'oklch(0 0 0 / 50%)',
    borderRadius: 'var(--radius)',
    fontFamily: 'inherit',
  },
}
