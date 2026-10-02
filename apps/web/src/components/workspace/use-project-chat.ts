'use client'

import type { ChatMessage, ChatUnread } from '@kaxolax/contracts'
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { api, ApiError } from '@/lib/api'
import { chatErrorMessage, mergeMessages } from '@/lib/chat'
import { chatFeed } from '@/lib/project-events'

/** Page visible (onglet du navigateur au premier plan). */
function subscribeVisibility(callback: () => void): () => void {
  document.addEventListener('visibilitychange', callback)
  return () => {
    document.removeEventListener('visibilitychange', callback)
  }
}

function useDocumentVisible(): boolean {
  return useSyncExternalStore(
    subscribeVisibility,
    () => document.visibilityState === 'visible',
    () => false,
  )
}

export interface ProjectChat {
  messages: ChatMessage[]
  /** Des messages plus anciens restent à charger. */
  hasMore: boolean
  /** Non-lus (badge de l'onglet), relus depuis l'API : exacts après rechargement. */
  unread: number
  status: 'loading' | 'ready' | 'error'
  error: string | null
  loadingOlder: boolean
  loadOlder: () => Promise<void>
  /** Envoie un message (texte déjà encodé) ; rejette avec l'erreur de l'API. */
  send: (body: string) => Promise<void>
  retry: () => void
}

/**
 * Chat d'un projet : historique paginé (les plus récents, puis les plus anciens au défilement),
 * nouveaux messages relus à chaque événement `chat.message-created` (et au retour sur l'onglet,
 * pour ceux manqués pendant une coupure), badge de non-lus. Quand le chat est affiché (`active`)
 * et la page visible, les messages reçus sont marqués comme lus.
 */
export function useProjectChat(projectId: string | null, active: boolean): ProjectChat {
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [hasMore, setHasMore] = useState(false)
  const [unread, setUnread] = useState<ChatUnread | null>(null)
  const [status, setStatus] = useState<ProjectChat['status']>('loading')
  const [error, setError] = useState<string | null>(null)
  const [loadingOlder, setLoadingOlder] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const visible = useDocumentVisible()

  // Derniers messages connus, lus hors rendu (rattrapage, pagination).
  const latest = useRef<ChatMessage[]>([])
  useEffect(() => {
    latest.current = messages
  })

  // Chargement initial : les messages les plus récents et les non-lus.
  useEffect(() => {
    if (projectId === null) return
    const state = { active: true }
    api.chatMessages(projectId).then(
      (page) => {
        if (!state.active) return
        // Fusion : un rattrapage a pu arriver pendant le chargement.
        latest.current = mergeMessages(latest.current, page.messages)
        setMessages(latest.current)
        setHasMore(page.hasMore)
        setUnread(page.unread)
        setStatus('ready')
        setError(null)
      },
      (caught: unknown) => {
        if (!state.active) return
        setStatus('error')
        setError(chatErrorMessage(caught))
      },
    )
    return () => {
      state.active = false
      latest.current = []
      setMessages([])
      setHasMore(false)
      setUnread(null)
      setStatus('loading')
    }
  }, [projectId, attempt])

  /**
   * Relit les messages postérieurs au dernier connu, page après page. Un seul rattrapage à la
   * fois ; une demande pendant un rattrapage en relance un à la fin (rafale d'événements).
   */
  const running = useRef<Promise<void> | null>(null)
  const pending = useRef(false)
  const catchUp = useCallback((): Promise<void> => {
    if (projectId === null) return Promise.resolve()
    if (running.current) {
      pending.current = true
      return running.current
    }
    const run = async () => {
      for (;;) {
        const last = latest.current.at(-1)
        const page = await api.chatMessages(projectId, last ? { after: last.id } : {})
        latest.current = mergeMessages(latest.current, page.messages)
        setMessages(latest.current)
        setUnread(page.unread)
        if (!last) setHasMore(page.hasMore)
        if (!(last && page.hasMore) && !pending.current) return
        pending.current = false
      }
    }
    running.current = run()
      .catch(() => undefined)
      .finally(() => {
        running.current = null
      })
    return running.current
  }, [projectId])

  useEffect(() => chatFeed.subscribe(() => void catchUp()), [catchUp])

  // Retour sur le chat ou sur la page : messages manqués (coupure du temps réel).
  const shown = active && visible
  useEffect(() => {
    if (shown && status === 'ready') void catchUp()
  }, [shown, status, catchUp])

  // Chat affiché : tout ce qui est reçu est lu (la dernière lecture ne recule jamais côté API).
  const lastId = messages.at(-1)?.id ?? null
  const unreadCount = unread?.count ?? 0
  const marked = useRef<string | null>(null)
  useEffect(() => {
    if (!shown || projectId === null || lastId === null || unreadCount === 0) return
    if (marked.current === lastId) return
    marked.current = lastId
    api.markChatRead(projectId, lastId).then(
      (response) => {
        setUnread(response.unread)
      },
      () => {
        marked.current = null
      },
    )
  }, [shown, projectId, lastId, unreadCount])

  const loadOlder = useCallback(async () => {
    const first = latest.current[0]
    if (projectId === null || !first || loadingOlder) return
    setLoadingOlder(true)
    try {
      const page = await api.chatMessages(projectId, { before: first.id })
      latest.current = mergeMessages(page.messages, latest.current)
      setMessages(latest.current)
      setHasMore(page.hasMore)
    } catch (caught) {
      setError(chatErrorMessage(caught))
    } finally {
      setLoadingOlder(false)
    }
  }, [projectId, loadingOlder])

  const send = useCallback(
    async (body: string) => {
      if (projectId === null) throw new ApiError(404, undefined, 'Projet introuvable')
      const { message } = await api.sendChatMessage(projectId, body)
      latest.current = mergeMessages(latest.current, [message])
      setMessages(latest.current)
    },
    [projectId],
  )

  const retry = useCallback(() => {
    setStatus('loading')
    setError(null)
    setAttempt((count) => count + 1)
  }, [])

  return {
    messages,
    hasMore,
    unread: unreadCount,
    status,
    error,
    loadingOlder,
    loadOlder,
    send,
    retry,
  }
}
