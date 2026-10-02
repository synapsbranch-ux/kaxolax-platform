'use client'

import { UserButton } from '@clerk/nextjs'
import { cn } from '@kaxolax/ui'
import { BarChart3, FolderKanban, Megaphone, ScrollText, Users } from 'lucide-react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import type { ReactNode } from 'react'

const NAV = [
  { href: '/users', label: 'Utilisateurs', icon: Users },
  { href: '/projects', label: 'Projets', icon: FolderKanban },
  { href: '/banners', label: 'Bannière système', icon: Megaphone },
  { href: '/stats', label: 'Statistiques', icon: BarChart3 },
  { href: '/audit-log', label: 'Journal', icon: ScrollText },
] as const

/** Cadre de l'admin : navigation latérale (en haut sur petit écran) et contenu. */
export function AdminShell({ children }: { children: ReactNode }) {
  const pathname = usePathname()
  return (
    <div className="flex min-h-screen flex-col md:flex-row">
      <aside className="flex shrink-0 flex-col border-b bg-card md:w-60 md:border-r md:border-b-0">
        <div className="flex h-14 items-center justify-between px-4">
          <Link href="/users" className="font-bold tracking-tight">
            kaxolax <span className="font-normal text-muted-foreground">admin</span>
          </Link>
          <UserButton />
        </div>
        <nav className="flex gap-1 overflow-x-auto px-2 pb-2 md:flex-col md:pb-4">
          {NAV.map(({ href, label, icon: Icon }) => {
            const active = pathname === href || pathname.startsWith(`${href}/`)
            return (
              <Link
                key={href}
                href={href}
                aria-current={active ? 'page' : undefined}
                className={cn(
                  'flex items-center gap-2 rounded-md px-3 py-2 text-sm whitespace-nowrap text-muted-foreground hover:bg-accent hover:text-accent-foreground',
                  active && 'bg-accent text-accent-foreground',
                )}
              >
                <Icon className="size-4" aria-hidden />
                {label}
              </Link>
            )
          })}
        </nav>
      </aside>
      <main className="min-w-0 flex-1 p-4 md:p-8">{children}</main>
    </div>
  )
}
