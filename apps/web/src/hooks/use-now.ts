'use client'

import { useEffect, useState } from 'react'

/** Heure courante (ms), rafraîchie toutes les `intervalMs` tant que `active` est vrai. */
export function useNow(intervalMs: number, active = true): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    const timer = setInterval(() => {
      setNow(Date.now())
    }, intervalMs)
    return () => {
      clearInterval(timer)
    }
  }, [intervalMs, active])
  return now
}
