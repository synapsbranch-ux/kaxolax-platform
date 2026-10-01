'use client'

import { useClerk } from '@clerk/nextjs'
import { useEffect, useState } from 'react'
import { api, ApiError, type User } from '@/lib/api'

/**
 * Utilisateur local de la session Clerk (id interne). La page est déjà protégée par le proxy ; si
 * l'API refuse quand même la session (révoquée, compte supprimé), elle est fermée.
 */
export function useRequiredUser(): User | null {
  const clerk = useClerk()
  const [user, setUser] = useState<User | null>(null)
  useEffect(() => {
    let active = true
    api.me().then(
      ({ user: current }) => {
        if (active) setUser(current)
      },
      (error: unknown) => {
        if (error instanceof ApiError && error.status === 401) {
          void clerk.signOut({ redirectUrl: '/sign-in' })
        }
      },
    )
    return () => {
      active = false
    }
  }, [clerk])
  return user
}
