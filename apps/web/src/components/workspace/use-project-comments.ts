'use client'

import type { CommentThread, CreateCommentThreadInput } from '@kaxolax/contracts'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api, type ProjectTree } from '@/lib/api'
import { commentErrorMessage, threadsInTree, upsertThread } from '@/lib/comments'
import { commentFeed } from '@/lib/project-events'

export interface ProjectComments {
  threads: CommentThread[]
  status: 'loading' | 'ready' | 'error'
  error: string | null
  retry: () => void
  /** Ouvre un fil ; rejette avec l'erreur de l'API. */
  create: (input: CreateCommentThreadInput) => Promise<CommentThread>
  reply: (threadId: string, body: string) => Promise<void>
  edit: (threadId: string, commentId: string, body: string) => Promise<void>
  remove: (threadId: string, commentId: string) => Promise<void>
  setResolved: (threadId: string, resolved: boolean) => Promise<void>
}

/**
 * Fils de commentaires d'un projet : chargés à l'ouverture, puis tenus à jour par les événements
 * `comment.created` et `comment.thread-updated` du document meta (le fil concerné est relu) et
 * par les réponses de l'API aux actions locales. Au retour sur l'onglet du navigateur, tout est
 * relu (événements manqués pendant une coupure).
 *
 * La suppression d'un document (ou son retrait par une restauration) supprime ses fils côté
 * serveur sans événement de commentaire : les fils d'un document absent de `tree` sont masqués
 * aussitôt, et la liste est relue quand les documents de l'arborescence changent (un document
 * recréé par une restauration revient sans ses anciens fils).
 */
export function useProjectComments(
  projectId: string,
  tree: Pick<ProjectTree, 'documents'> | null = null,
): ProjectComments {
  const [threads, setThreads] = useState<CommentThread[]>([])
  const [status, setStatus] = useState<ProjectComments['status']>('loading')
  const [error, setError] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)
  // Relectures d'un fil en cours : la dernière demande l'emporte.
  const requests = useRef(new Map<string, number>())

  // Clé des documents de l'arborescence : relecture quand l'un d'eux apparaît ou disparaît.
  const documentsKey = useMemo(
    () =>
      tree
        ? tree.documents
            .map((document) => document.id)
            .sort()
            .join(',')
        : null,
    [tree],
  )

  const apply = useCallback((threadId: string, thread: CommentThread | null) => {
    setThreads((current) => upsertThread(current, threadId, thread))
  }, [])

  useEffect(() => {
    const state = { active: true }
    const reload = () => {
      api.commentThreads(projectId).then(
        (loaded) => {
          if (!state.active) return
          setThreads(loaded)
          setStatus('ready')
          setError(null)
        },
        (caught: unknown) => {
          if (!state.active) return
          setStatus((current) => (current === 'ready' ? current : 'error'))
          setError(commentErrorMessage(caught))
        },
      )
    }
    reload()
    const onVisible = () => {
      if (document.visibilityState === 'visible') reload()
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      state.active = false
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [projectId, attempt, documentsKey])

  useEffect(() => {
    const state = { active: true }
    const unsubscribe = commentFeed.subscribe((event) => {
      const serial = (requests.current.get(event.threadId) ?? 0) + 1
      requests.current.set(event.threadId, serial)
      if (event.type === 'comment.thread-updated' && event.change === 'deleted') {
        apply(event.threadId, null)
        return
      }
      api.commentThread(projectId, event.threadId).then(
        (thread) => {
          if (state.active && requests.current.get(event.threadId) === serial)
            apply(event.threadId, thread)
        },
        () => undefined,
      )
    })
    return () => {
      state.active = false
      unsubscribe()
    }
  }, [projectId, apply])

  const create = useCallback(
    async (input: CreateCommentThreadInput) => {
      const thread = await api.createCommentThread(projectId, input)
      if (thread === null) throw new Error('Le commentaire n’a pas été créé.')
      apply(thread.id, thread)
      return thread
    },
    [projectId, apply],
  )
  const reply = useCallback(
    async (threadId: string, body: string) => {
      apply(threadId, await api.replyToComment(projectId, threadId, body))
    },
    [projectId, apply],
  )
  const edit = useCallback(
    async (threadId: string, commentId: string, body: string) => {
      apply(threadId, await api.editComment(projectId, threadId, commentId, body))
    },
    [projectId, apply],
  )
  const remove = useCallback(
    async (threadId: string, commentId: string) => {
      apply(threadId, await api.deleteComment(projectId, threadId, commentId))
    },
    [projectId, apply],
  )
  const setResolved = useCallback(
    async (threadId: string, resolved: boolean) => {
      apply(threadId, await api.setCommentThreadResolved(projectId, threadId, resolved))
    },
    [projectId, apply],
  )

  const visible = useMemo(() => threadsInTree(threads, tree), [threads, tree])

  return {
    threads: visible,
    status,
    error,
    retry: () => {
      setStatus('loading')
      setAttempt((value) => value + 1)
    },
    create,
    reply,
    edit,
    remove,
    setResolved,
  }
}
