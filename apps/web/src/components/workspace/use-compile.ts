'use client'

import type { CompileOptions, CompileResult } from '@kaxolax/contracts'
import { useCallback, useEffect, useRef, useState } from 'react'
import { api, errorMessage } from '@/lib/api'

export interface CompileState {
  /** Dernier résultat (null : projet jamais compilé). */
  result: CompileResult | null
  /** Date de réception de `result` (ses liens présignés expirent une heure après la signature). */
  receivedAt: number
  compiling: boolean
  /** Lance une compilation ; un nouvel appel remplace la précédente (seule la dernière compte). */
  compile: () => Promise<void>
  stop: () => Promise<void>
  clearCache: () => Promise<void>
}

/**
 * Compilation du projet : attend que les dernières frappes soient arrivées au serveur (`flush`),
 * envoie les options de l'utilisateur (brouillon, arrêt à la première erreur) et garde le résultat.
 */
export function useCompile({
  projectId,
  flush,
  options,
  onError,
}: {
  projectId: string
  flush: () => Promise<void>
  options: CompileOptions
  onError: (message: string | null) => void
}): CompileState {
  const [received, setReceived] = useState<{ result: CompileResult; receivedAt: number } | null>(
    null,
  )
  const [compiling, setCompiling] = useState(false)
  const request = useRef(0)
  // Valeurs lues au moment de l'appel : `compile` reste stable (raccourcis, auto-compilation).
  const latest = useRef({ flush, options, onError })
  useEffect(() => {
    latest.current = { flush, options, onError }
  })

  const compile = useCallback(async () => {
    // Un nouveau clic arrête la compilation précédente (côté serveur) ; seule la dernière réponse compte.
    const current = ++request.current
    setCompiling(true)
    latest.current.onError(null)
    try {
      await latest.current.flush()
      const compiled = await api.compile(projectId, latest.current.options)
      if (current !== request.current) return
      setReceived({ result: compiled, receivedAt: Date.now() })
    } catch (caught) {
      if (current === request.current) latest.current.onError(errorMessage(caught))
    } finally {
      if (current === request.current) setCompiling(false)
    }
  }, [projectId])

  const stop = useCallback(async () => {
    try {
      await api.stopCompile(projectId)
    } catch (caught) {
      latest.current.onError(errorMessage(caught))
    }
  }, [projectId])

  const clearCache = useCallback(async () => {
    try {
      await api.clearCache(projectId)
    } catch (caught) {
      latest.current.onError(errorMessage(caught))
    }
  }, [projectId])

  return {
    result: received?.result ?? null,
    receivedAt: received?.receivedAt ?? 0,
    compiling,
    compile,
    stop,
    clearCache,
  }
}
