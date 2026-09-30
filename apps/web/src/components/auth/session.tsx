'use client'

import { useRouter } from 'next/navigation'
import { useEffect, useState } from 'react'
import { api, ApiError, type User } from '@/lib/api'

/** Utilisateur connecté ; redirige vers /login si la session a expiré. */
export function useRequiredUser(): User | null {
  const router = useRouter()
  const [user, setUser] = useState<User | null>(null)
  useEffect(() => {
    let active = true
    api.me().then(
      ({ user: current }) => {
        if (active) setUser(current)
      },
      (error: unknown) => {
        if (error instanceof ApiError && error.status === 401) {
          router.replace(`/login?next=${encodeURIComponent(window.location.pathname)}`)
        }
      },
    )
    return () => {
      active = false
    }
  }, [router])
  return user
}
