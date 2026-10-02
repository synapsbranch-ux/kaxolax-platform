'use client'

import { HocuspocusProvider, type HocuspocusProviderWebsocket } from '@hocuspocus/provider'
import { metaDocumentName } from '@kaxolax/collab'
import { type PresenceUser, REALTIME_FORBIDDEN_CLOSE_CODE } from '@kaxolax/contracts'
import { useEffect, useRef, useState } from 'react'
import * as Y from 'yjs'
import { api } from '@/lib/api'
import { groupPresence, type OnlinePerson } from '@/lib/presence'
import { parseRealtimeMessage, type RealtimeMessage } from '@/lib/project-events'

/** Raison de fermeture d'une connexion retirée (Forbidden de Hocuspocus). */
const FORBIDDEN_REASON = 'Forbidden'
/** Premier délai avant de rouvrir la connexion après un refus, doublé à chaque échec. */
const RECONNECT_MIN_MS = 2_000
const RECONNECT_MAX_MS = 30_000

/**
 * Connexion au document meta du projet (`project:{id}:meta`), ouverte avec la page projet sur la
 * connexion WebSocket partagée : publie sa présence (identité, fichier de l'onglet actif), donne
 * les autres personnes en ligne et transmet les messages sans état (événements du projet,
 * changement de rôle). `onAccessLost` est appelé quand le serveur ferme ou refuse la connexion
 * (membre retiré, mais aussi échec passager : jeton non obtenu, erreur du serveur) : la page
 * vérifie son accès, et s'il est confirmé la connexion est rouverte (délai croissant), car le
 * fournisseur ne renvoie pas son jeton de lui-même avant une reconnexion du WebSocket.
 */
export function useProjectMeta({
  projectId,
  socket,
  self,
  activeId,
  onMessage,
  onAccessLost,
  onPeopleChange,
}: {
  projectId: string
  socket: HocuspocusProviderWebsocket | null
  /** Sa propre identité de présence (null tant que l'utilisateur n'est pas chargé). */
  self: PresenceUser | null
  /** Fichier de l'onglet actif (document ou fichier binaire). */
  activeId: string | null
  onMessage: (message: RealtimeMessage) => void
  /** Vérifie l'accès ; résolu à faux si l'utilisateur n'est plus membre. */
  onAccessLost: () => Promise<boolean>
  /**
   * Après chaque changement de la présence (suivi d'un collaborateur), seulement une fois
   * synchronisé : une coupure efface la présence des autres sans qu'ils soient partis.
   */
  onPeopleChange?: (people: OnlinePerson[]) => void
}): { people: OnlinePerson[] } {
  const [people, setPeople] = useState<OnlinePerson[]>([])
  const provider = useRef<HocuspocusProvider | null>(null)
  const callbacks = useRef({ onMessage, onAccessLost, onPeopleChange })
  const current = useRef({ self, activeId })
  // Réouverture de la connexion après un refus passager ; échecs consécutifs (délai croissant).
  const [attempt, setAttempt] = useState(0)
  const failures = useRef(0)
  useEffect(() => {
    callbacks.current = { onMessage, onAccessLost, onPeopleChange }
    current.current = { self, activeId }
  })

  const selfId = self?.id ?? null
  useEffect(() => {
    if (socket === null || selfId === null) return
    const doc = new Y.Doc()
    const created = new HocuspocusProvider({
      websocketProvider: socket,
      name: metaDocumentName(projectId),
      document: doc,
      // Plusieurs onglets ou un double montage de React sur la même connexion.
      sessionAwareness: true,
      token: async () => (await api.realtimeToken(projectId)).token,
    })
    provider.current = created
    const awareness = created.awareness
    // Identité publiée pour l'affichage local ; le serveur impose de toute façon la sienne.
    awareness?.setLocalState({
      user: current.current.self,
      documentId: current.current.activeId,
    })
    const refresh = () => {
      const next = awareness ? groupPresence(awareness.getStates(), selfId) : []
      setPeople(next)
      if (created.isSynced) callbacks.current.onPeopleChange?.(next)
    }
    awareness?.on('change', refresh)
    created.on('synced', () => {
      failures.current = 0
      refresh()
    })
    let retry: ReturnType<typeof setTimeout> | null = null
    let disposed = false
    const accessLost = () => {
      if (retry !== null) return
      void callbacks.current.onAccessLost().then((stillMember) => {
        if (!stillMember || disposed || retry !== null) return
        const delay = Math.min(RECONNECT_MAX_MS, RECONNECT_MIN_MS * 2 ** failures.current)
        failures.current++
        retry = setTimeout(() => {
          setAttempt((count) => count + 1)
        }, delay)
      })
    }
    created.on('stateless', ({ payload }: { payload: string }) => {
      const message = parseRealtimeMessage(payload)
      if (message !== null) callbacks.current.onMessage(message)
    })
    created.on('close', ({ event }: { event: { code: number; reason: string } }) => {
      if (event.code === REALTIME_FORBIDDEN_CLOSE_CODE || event.reason === FORBIDDEN_REASON)
        accessLost()
    })
    created.on('authenticationFailed', accessLost)
    created.attach()
    return () => {
      disposed = true
      if (retry !== null) clearTimeout(retry)
      awareness?.off('change', refresh)
      provider.current = null
      created.destroy()
      doc.destroy()
      setPeople([])
    }
  }, [projectId, socket, selfId, attempt])

  // Onglet actif : publié dans la présence (pastilles de l'arborescence, suivi).
  useEffect(() => {
    provider.current?.awareness?.setLocalStateField('documentId', activeId)
  }, [activeId])

  return { people }
}
