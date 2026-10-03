'use client'

import type {
  DecideSuggestionsInput,
  DecideSuggestionsResponse,
  Suggestion,
} from '@kaxolax/contracts'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api, type ProjectTree } from '@/lib/api'
import { threadsInTree } from '@/lib/comments'
import { suggestionFeed } from '@/lib/project-events'
import { suggestionsGone } from '@/lib/suggestion-recorder'
import {
  applyDecisions,
  mergeReloaded,
  suggestionErrorMessage,
  upsertSuggestion,
} from '@/lib/suggestions'

/** Relances au plus d'une décision groupée qui dépasse la limite par requête. */
const MAX_DECIDE_ROUNDS = 20

export interface ProjectSuggestions {
  /** Suggestions ouvertes et obsolètes des documents de l'arborescence. */
  suggestions: Suggestion[]
  status: 'loading' | 'ready' | 'error'
  error: string | null
  retry: () => void
  /** Suggestion enregistrée par le mode Suggérer (réponse de l'API). */
  saved: (suggestion: Suggestion) => void
  /** Suggestion retirée par son auteur. */
  removed: (id: string) => void
  /** Accepter ou refuser ; une décision groupée est relancée tant qu'il en reste. */
  decide: (input: DecideSuggestionsInput) => Promise<DecideSuggestionsResponse>
  /** Retirer sa suggestion ouverte ou obsolète. */
  withdraw: (id: string) => Promise<void>
}

/**
 * Suggestions d'un projet (suivi des modifications) : ouvertes et obsolètes, chargées à
 * l'ouverture puis tenues à jour par les événements `suggestion.*` du document meta (la
 * suggestion créée ou modifiée est relue, une décision s'applique directement) et par les
 * réponses de l'API aux actions locales. Une suggestion décidée ou retirée est annoncée aux
 * éditeurs ouverts (`suggestionsGone`), qui oublient son brouillon du mode Suggérer. Au retour sur l'onglet, et quand les documents de
 * l'arborescence changent, tout est relu : seule la dernière relecture compte, et une suggestion
 * touchée pendant la lecture (événement, action locale) garde son état courant (`mergeReloaded`).
 */
export function useProjectSuggestions(
  projectId: string,
  tree: Pick<ProjectTree, 'documents'> | null = null,
): ProjectSuggestions {
  const [suggestions, setSuggestions] = useState<Suggestion[]>([])
  const [status, setStatus] = useState<ProjectSuggestions['status']>('loading')
  const [error, setError] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)
  // Changements de chaque suggestion (relecture, événement, action locale) : la dernière relecture
  // demandée l'emporte, et un rechargement complet ne remplace pas un état plus récent.
  const requests = useRef(new Map<string, number>())
  const reloads = useRef(0)
  const touch = useCallback((id: string) => {
    const serial = (requests.current.get(id) ?? 0) + 1
    requests.current.set(id, serial)
    return serial
  }, [])

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

  const apply = useCallback((id: string, suggestion: Suggestion | null) => {
    setSuggestions((current) => upsertSuggestion(current, id, suggestion))
  }, [])

  useEffect(() => {
    const state = { active: true }
    const reload = () => {
      reloads.current += 1
      const serial = reloads.current
      const before = new Map(requests.current)
      Promise.all([api.suggestions(projectId, 'open'), api.suggestions(projectId, 'stale')]).then(
        ([open, stale]) => {
          // Une relecture plus récente est partie : celle-ci est dépassée.
          if (!state.active || serial !== reloads.current) return
          const touched = new Set<string>()
          for (const [id, count] of requests.current) {
            if (before.get(id) !== count) touched.add(id)
          }
          setSuggestions((current) => mergeReloaded(current, [...open, ...stale], touched))
          setStatus('ready')
          setError(null)
        },
        (caught: unknown) => {
          if (!state.active || serial !== reloads.current) return
          setStatus((current) => (current === 'ready' ? current : 'error'))
          setError(suggestionErrorMessage(caught))
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
    const refetch = (id: string) => {
      const serial = touch(id)
      api.suggestion(projectId, id).then(
        (suggestion) => {
          if (state.active && requests.current.get(id) === serial) apply(id, suggestion)
        },
        () => undefined,
      )
    }
    const unsubscribe = suggestionFeed.subscribe((event) => {
      switch (event.type) {
        case 'suggestion.created':
          refetch(event.suggestionId)
          break
        case 'suggestion.updated':
          if (event.change === 'deleted') {
            touch(event.suggestionId)
            apply(event.suggestionId, null)
            suggestionsGone.publish([event.suggestionId])
          } else {
            refetch(event.suggestionId)
          }
          break
        case 'suggestion.decided':
          for (const decision of event.decisions) touch(decision.suggestionId)
          setSuggestions((current) => applyDecisions(current, event))
          suggestionsGone.publish(event.decisions.map((decision) => decision.suggestionId))
          break
      }
    })
    return () => {
      state.active = false
      unsubscribe()
    }
  }, [projectId, apply, touch])

  const decide = useCallback(
    async (input: DecideSuggestionsInput) => {
      let response = await api.decideSuggestions(projectId, input)
      const results = [...response.results]
      const updated = [...response.suggestions]
      // Décision groupée au-delà de la limite par requête : relancée sur le reste.
      for (
        let round = 1;
        response.remaining > 0 && input.ids === undefined && round < MAX_DECIDE_ROUNDS;
        round++
      ) {
        response = await api.decideSuggestions(projectId, input)
        results.push(...response.results)
        updated.push(...response.suggestions)
      }
      for (const suggestion of updated) touch(suggestion.id)
      // Brouillons des suggestions décidées oubliés par l'éditeur ouvert (mode Suggérer).
      suggestionsGone.publish(
        updated.filter((suggestion) => suggestion.status !== 'open').map(({ id }) => id),
      )
      setSuggestions((current) =>
        updated.reduce(
          (list, suggestion) => upsertSuggestion(list, suggestion.id, suggestion),
          current,
        ),
      )
      return { results, suggestions: updated, remaining: response.remaining }
    },
    [projectId, touch],
  )

  const withdraw = useCallback(
    async (id: string) => {
      await api.deleteSuggestion(projectId, id)
      touch(id)
      apply(id, null)
      suggestionsGone.publish([id])
    },
    [projectId, apply, touch],
  )

  const saved = useCallback(
    (suggestion: Suggestion) => {
      touch(suggestion.id)
      apply(suggestion.id, suggestion)
    },
    [apply, touch],
  )
  const removed = useCallback(
    (id: string) => {
      touch(id)
      apply(id, null)
    },
    [apply, touch],
  )

  const visible = useMemo(() => threadsInTree(suggestions, tree), [suggestions, tree])

  return {
    suggestions: visible,
    status,
    error,
    retry: () => {
      setStatus('loading')
      setAttempt((value) => value + 1)
    },
    saved,
    removed,
    decide,
    withdraw,
  }
}
