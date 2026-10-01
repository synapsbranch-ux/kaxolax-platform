'use client'

import { UserButton } from '@clerk/nextjs'
import Link from 'next/link'
import type { ReactNode } from 'react'
import type { User } from '@/lib/api'

export function AppHeader({ user, children }: { user: User | null; children?: ReactNode }) {
  return (
    <header className="flex h-12 shrink-0 items-center gap-3 border-b px-4">
      <Link href="/dashboard" className="font-bold tracking-tight">
        kaxolax
      </Link>
      <div className="flex min-w-0 flex-1 items-center gap-2">{children}</div>
      {user ? (
        <span className="hidden text-sm text-muted-foreground sm:inline">{user.email}</span>
      ) : null}
      {/* Compte : profil, sécurité (MFA, sessions), déconnexion. */}
      <UserButton userProfileUrl="/account" userProfileMode="navigation" />
    </header>
  )
}
