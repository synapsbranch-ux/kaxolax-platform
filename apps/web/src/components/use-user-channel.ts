'use client'

import { HocuspocusProvider, HocuspocusProviderWebsocket } from '@hocuspocus/provider'
import { type BroadcastEvent, REALTIME_FORBIDDEN_CLOSE_CODE } from '@kaxolax/contracts'
import { useEffect, useRef, useState } from 'react'
import * as Y from 'yjs'
import { api } from '@/lib/api'
import { parseBroadcastMessage } from '@/lib/project-events'
import { userChannelRetryDelay } from '@/lib/user-channel'

/**
 * Canal temps réel du compte (`user:{id}`, service temps réel), ouvert sur toutes les pages
 * connectées par la bannière système : il reçoit les événements diffusés à tous (bannière), quelle
 * que soit l'instance du service. Connexion WebSocket dédiée, sans contenu ni présence ; le jeton
 * (`POST /me/realtime-token`) est redemandé à chaque connexion. `onSynced` est appelé à chaque
 * (re)connexion : la page relit alors l'état qu'un événement manqué aurait changé. Un refus ou
 * une fermeture par le serveur rouvre le canal plus tard (délai croissant) ; les coupures réseau
 * sont reprises par le WebSocket.
 */
export function useUserChannel({
  onEvent,
  onSynced,
}: {
  onEvent: (event: BroadcastEvent) => void
  onSynced?: () => void
}): void {
  const callbacks = useRef({ onEvent, onSynced })
  useEffect(() => {
    callbacks.current = { onEvent, onSynced }
  })
  // Réouverture après un échec ; échecs consécutifs (délai croissant).
  const [attempt, setAttempt] = useState(0)
  const failures = useRef(0)

  useEffect(() => {
    let disposed = false
    let retry: ReturnType<typeof setTimeout> | null = null
    let socket: HocuspocusProviderWebsocket | null = null
    let provider: HocuspocusProvider | null = null
    const doc = new Y.Doc()
    const retryLater = () => {
      if (disposed || retry !== null) return
      const delay = userChannelRetryDelay(failures.current)
      failures.current++
      retry = setTimeout(() => {
        setAttempt((count) => count + 1)
      }, delay)
    }
    api.userRealtimeToken().then(({ url, name }) => {
      if (disposed) return
      socket = new HocuspocusProviderWebsocket({ url })
      provider = new HocuspocusProvider({
        websocketProvider: socket,
        name,
        document: doc,
        token: async () => (await api.userRealtimeToken()).token,
      })
      provider.on('stateless', ({ payload }: { payload: string }) => {
        const event = parseBroadcastMessage(payload)
        if (event !== null) callbacks.current.onEvent(event)
      })
      provider.on('synced', () => {
        failures.current = 0
        callbacks.current.onSynced?.()
      })
      provider.on('authenticationFailed', retryLater)
      provider.on('close', ({ event }: { event: { code: number } }) => {
        if (event.code === REALTIME_FORBIDDEN_CLOSE_CODE) retryLater()
      })
      provider.attach()
    }, retryLater)
    return () => {
      disposed = true
      if (retry !== null) clearTimeout(retry)
      provider?.destroy()
      socket?.destroy()
      doc.destroy()
    }
  }, [attempt])
}
