'use client'

import { HocuspocusProviderWebsocket } from '@hocuspocus/provider'
import { useEffect, useState } from 'react'
import { api, errorMessage } from '@/lib/api'

export interface RealtimeSocket {
  /** Connexion partagée (null tant que l'URL n'est pas connue, ou en échec). */
  socket: HocuspocusProviderWebsocket | null
  /** Échec de la demande du premier jeton (accès refusé, API indisponible). */
  error: string | null
}

/**
 * Connexion WebSocket unique au service temps réel pour tout le projet ; chaque document ouvert
 * s'y attache. L'URL vient de l'API avec le premier jeton.
 */
export function useRealtimeSocket(projectId: string): RealtimeSocket {
  const [state, setState] = useState<RealtimeSocket>({ socket: null, error: null })
  useEffect(() => {
    let active = true
    let created: HocuspocusProviderWebsocket | null = null
    api.realtimeToken(projectId).then(
      ({ url }) => {
        if (!active) return
        created = new HocuspocusProviderWebsocket({ url })
        setState({ socket: created, error: null })
      },
      (caught: unknown) => {
        if (active) setState({ socket: null, error: errorMessage(caught) })
      },
    )
    return () => {
      active = false
      created?.destroy()
      setState({ socket: null, error: null })
    }
  }, [projectId])
  return state
}
