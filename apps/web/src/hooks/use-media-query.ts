'use client'

import { useCallback, useSyncExternalStore } from 'react'

/** Largeur sous laquelle l'éditeur et le PDF passent en onglets et la sidebar en tiroir. */
export const NARROW_QUERY = '(max-width: 1023.98px)'

/** Vrai si la requête média correspond (faux au rendu serveur). */
export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => {
      const list = window.matchMedia(query)
      list.addEventListener('change', onChange)
      return () => {
        list.removeEventListener('change', onChange)
      }
    },
    [query],
  )
  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(query).matches,
    () => false,
  )
}

/** Écran de moins de 1024 px de large. */
export function useIsNarrow(): boolean {
  return useMediaQuery(NARROW_QUERY)
}
