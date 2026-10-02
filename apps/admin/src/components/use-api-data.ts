'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { errorMessage } from '@/lib/api'

interface Loaded<T> {
  key: string
  data: T | null
  error: string | null
}

/**
 * Charge une ressource de l'API à chaque changement de `key` (ou après `reload()`). Pendant un
 * rechargement, la donnée précédente reste affichée (`loading` vrai).
 */
export function useApiData<T>(load: () => Promise<T>, key: string) {
  const loadRef = useRef(load)
  useEffect(() => {
    loadRef.current = load
  })
  const [version, setVersion] = useState(0)
  const [state, setState] = useState<Loaded<T> | null>(null)
  const requestKey = `${key}#${String(version)}`

  useEffect(() => {
    let active = true
    loadRef.current().then(
      (data) => {
        if (active) setState({ key: requestKey, data, error: null })
      },
      (error: unknown) => {
        if (active)
          setState((previous) => ({
            key: requestKey,
            data: previous?.data ?? null,
            error: errorMessage(error),
          }))
      },
    )
    return () => {
      active = false
    }
  }, [requestKey])

  const reload = useCallback(() => {
    setVersion((value) => value + 1)
  }, [])

  return {
    data: state?.data ?? null,
    error: state?.key === requestKey ? state.error : null,
    loading: state?.key !== requestKey,
    reload,
  }
}
