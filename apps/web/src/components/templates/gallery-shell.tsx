import { Logo } from '@kaxolax/ui'
import Link from 'next/link'
import type { ReactNode } from 'react'

/**
 * Mise en page des pages publiques de la galerie : barre (logo, galerie, accès au tableau de bord
 * ou connexion) et contenu centré.
 */
export function GalleryShell({
  isAuthenticated,
  children,
}: {
  isAuthenticated: boolean
  children: ReactNode
}) {
  const linkClass =
    'rounded-md px-2 py-1 text-sm text-muted-foreground outline-none hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50'
  return (
    <div className="flex min-h-dvh flex-col bg-background text-foreground">
      <header className="sticky top-0 z-10 border-b bg-background/95 backdrop-blur">
        <div className="mx-auto flex h-bar max-w-6xl items-center gap-3 px-4">
          <Link
            href={isAuthenticated ? '/dashboard' : '/templates'}
            className="flex items-center gap-2 rounded-md font-semibold tracking-tight outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
          >
            <Logo size={22} title="" />
            Kaxolax
          </Link>
          <nav aria-label="Navigation" className="ml-auto flex items-center gap-1">
            <Link href="/templates" className={linkClass}>
              Templates
            </Link>
            <Link href="/pricing" className={linkClass}>
              Tarifs
            </Link>
            <Link href={isAuthenticated ? '/dashboard' : '/sign-in'} className={linkClass}>
              {isAuthenticated ? 'Mes projets' : 'Se connecter'}
            </Link>
          </nav>
        </div>
      </header>
      <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-6 md:py-8">{children}</main>
    </div>
  )
}
