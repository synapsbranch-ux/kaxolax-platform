'use client'

import { Button } from '@kaxolax/ui'
import { LogOutIcon } from 'lucide-react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import type { ReactNode } from 'react'
import { api, type User } from '@/lib/api'

export function AppHeader({ user, children }: { user: User | null; children?: ReactNode }) {
  const router = useRouter()
  return (
    <header className="flex h-12 shrink-0 items-center gap-3 border-b px-4">
      <Link href="/dashboard" className="font-bold tracking-tight">
        kaxolax
      </Link>
      <div className="flex min-w-0 flex-1 items-center gap-2">{children}</div>
      {user ? (
        <span className="hidden text-sm text-muted-foreground sm:inline">{user.email}</span>
      ) : null}
      <Button
        variant="ghost"
        size="sm"
        onClick={() =>
          void api.logout().finally(() => {
            router.replace('/login')
          })
        }
        aria-label="Se déconnecter"
      >
        <LogOutIcon />
        <span className="hidden sm:inline">Déconnexion</span>
      </Button>
    </header>
  )
}
