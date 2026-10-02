import { Logo } from '@kaxolax/ui'
import Link from 'next/link'
import type { ReactNode } from 'react'

/**
 * Mise en page des écrans de connexion et d'inscription (composants Clerk), avec un lien vers la
 * galerie publique de templates, consultable sans compte.
 */
export function AuthShell({ children }: { children: ReactNode }) {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-6 px-4 py-8">
      <p className="flex items-center gap-2 text-2xl font-bold tracking-tight">
        <Logo size={32} title="" />
        Kaxolax
      </p>
      {children}
      <Link
        href="/templates"
        className="rounded-sm text-sm text-muted-foreground underline-offset-4 outline-none hover:text-foreground hover:underline focus-visible:ring-[3px] focus-visible:ring-ring/50"
      >
        Parcourir la galerie de templates
      </Link>
    </main>
  )
}
