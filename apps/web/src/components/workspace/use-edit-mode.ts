'use client'

import type { ProjectRole } from '@kaxolax/contracts'
import { useCallback, useSyncExternalStore } from 'react'
import {
  type EditMode,
  editModeChoice,
  type EditModeChoice,
  effectiveEditMode,
  readEditMode,
  writeEditMode,
} from '@/lib/suggestions'

const listeners = new Set<() => void>()

function storage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage
  } catch {
    return null
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  // Autre onglet du même navigateur : même mode.
  const onStorage = (event: StorageEvent) => {
    if (event.key?.startsWith('kaxolax:edit-mode:') === true) listener()
  }
  window.addEventListener('storage', onStorage)
  return () => {
    listeners.delete(listener)
    window.removeEventListener('storage', onStorage)
  }
}

export interface EditModeState {
  /** Mode effectif (null : lecteur, ni bascule ni suggestion). */
  mode: EditMode | null
  choice: EditModeChoice
  /** Change le mode mémorisé (sans effet pour un relecteur, toujours en Suggérer). */
  setMode: (mode: EditMode) => void
}

/**
 * Mode Modifier / Suggérer de l'éditeur : mémorisé dans le stockage local, par utilisateur et
 * par projet ; Suggérer imposé à un relecteur, aucun mode pour un lecteur.
 */
export function useEditMode(
  projectId: string,
  userId: string | null,
  role: ProjectRole | null,
): EditModeState {
  const stored = useSyncExternalStore(
    subscribe,
    () => (userId === null ? null : readEditMode(storage(), userId, projectId)),
    () => null,
  )
  const choice = editModeChoice(role)
  const setMode = useCallback(
    (mode: EditMode) => {
      if (userId === null || choice !== 'choose') return
      writeEditMode(storage(), userId, projectId, mode)
      for (const listener of [...listeners]) listener()
    },
    [userId, projectId, choice],
  )
  return { mode: effectiveEditMode(role, stored), choice, setMode }
}
