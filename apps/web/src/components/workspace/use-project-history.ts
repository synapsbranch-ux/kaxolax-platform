'use client'

import type { ProjectVersion, VersionAuthor } from '@kaxolax/contracts'
import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '@/lib/api'
import { historyErrorMessage } from '@/lib/history'
import { historyFeed } from '@/lib/project-events'

export interface ProjectHistory {
  versions: ProjectVersion[]
  authors: ReadonlyMap<string, VersionAuthor>
  /** Conservation du plan du propriétaire (jours) ; null : historique complet. */
  retentionDays: number | null
  hasMore: boolean
  loading: boolean
  error: string | null
  /** Relit la première page (après une restauration). */
  reload: () => void
  loadMore: () => Promise<void>
  /** Remplace une version de la liste (label modifié). */
  replace: (version: ProjectVersion) => void
  /** Auteurs vus dans un détail de version (complète la liste des noms). */
  addAuthors: (authors: readonly VersionAuthor[]) => void
}

/**
 * Liste des versions du projet, chargée à l'ouverture du tiroir Historique et relue à chaque
 * nouvelle version annoncée par le service temps réel (`version.created`) tant qu'il est ouvert.
 */
export function useProjectHistory(projectId: string, open: boolean): ProjectHistory {
  const [versions, setVersions] = useState<ProjectVersion[]>([])
  const [authors, setAuthors] = useState<ReadonlyMap<string, VersionAuthor>>(new Map())
  const [retentionDays, setRetentionDays] = useState<number | null>(null)
  const [cursor, setCursor] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Seule la dernière requête de la première page compte (rechargements rapprochés).
  const request = useRef(0)

  const addAuthors = useCallback((list: readonly VersionAuthor[]) => {
    if (list.length === 0) return
    setAuthors((current) => {
      const next = new Map(current)
      for (const author of list) next.set(author.id, author)
      return next
    })
  }, [])

  // Première page, relue à l'ouverture, à chaque nouvelle version annoncée et sur demande
  // (`reload` incrémente `attempt`). Seule la dernière réponse compte.
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    if (!open) return
    const state = { active: true }
    const fetchFirst = () => {
      const current = ++request.current
      api.versions(projectId).then(
        (page) => {
          if (!state.active || current !== request.current) return
          setVersions(page.versions)
          setCursor(page.nextCursor)
          setRetentionDays(page.retentionDays)
          addAuthors(page.authors)
          setError(null)
          setLoaded(true)
        },
        (caught: unknown) => {
          if (!state.active || current !== request.current) return
          setError(historyErrorMessage(caught))
          setLoaded(true)
        },
      )
    }
    fetchFirst()
    const unsubscribe = historyFeed.subscribe(fetchFirst)
    return () => {
      state.active = false
      unsubscribe()
    }
  }, [open, projectId, attempt, addAuthors])

  const reload = useCallback(() => {
    setAttempt((value) => value + 1)
  }, [])

  const loadMore = useCallback(async () => {
    if (cursor === null) return
    setLoading(true)
    try {
      const page = await api.versions(projectId, cursor)
      setVersions((current) => [
        ...current,
        ...page.versions.filter((version) => !current.some((known) => known.id === version.id)),
      ])
      setCursor(page.nextCursor)
      addAuthors(page.authors)
    } catch (caught) {
      setError(historyErrorMessage(caught))
    } finally {
      setLoading(false)
    }
  }, [projectId, cursor, addAuthors])

  const replace = useCallback((version: ProjectVersion) => {
    setVersions((current) => current.map((known) => (known.id === version.id ? version : known)))
  }, [])

  return {
    versions,
    authors,
    retentionDays,
    hasMore: cursor !== null,
    loading: loading || !loaded,
    error,
    reload,
    loadMore,
    replace,
    addAuthors,
  }
}
