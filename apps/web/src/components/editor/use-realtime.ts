'use client'

import { HocuspocusProviderWebsocket } from '@hocuspocus/provider'
import { useEffect, useState } from 'react'
import { api } from '@/lib/api'

/**
 * Connexion WebSocket unique au service temps réel pour tout le projet ; chaque document ouvert
 * s'y attache. L'URL vient de l'API avec le premier jeton.
 */
export function useRealtimeSocket(projectId: string): HocuspocusProviderWebsocket | null {
  const [socket, setSocket] = useState<HocuspocusProviderWebsocket | null>(null)
  useEffect(() => {
    let active = true
    let created: HocuspocusProviderWebsocket | null = null
    void api.realtimeToken(projectId).then(({ url }) => {
      if (!active) return
      created = new HocuspocusProviderWebsocket({ url })
      setSocket(created)
    })
    return () => {
      active = false
      created?.destroy()
      setSocket(null)
    }
  }, [projectId])
  return socket
}
