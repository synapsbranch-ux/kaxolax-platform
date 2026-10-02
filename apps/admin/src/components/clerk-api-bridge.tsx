'use client'

import { useAuth } from '@clerk/nextjs'
import { useEffect } from 'react'
import { setTokenGetter } from '@/lib/api'

/**
 * Donne au client API l'accès au jeton de session Clerk. Les requêtes lancées avant le chargement
 * de Clerk attendent que ce composant ait enregistré le jeton.
 */
export function ClerkApiBridge() {
  const { isLoaded, getToken } = useAuth()
  useEffect(() => {
    if (isLoaded) setTokenGetter(() => getToken())
  }, [isLoaded, getToken])
  return null
}
