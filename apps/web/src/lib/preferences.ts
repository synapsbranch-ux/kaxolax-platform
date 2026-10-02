import {
  MAX_OPEN_TABS_PER_PROJECT,
  mergePreferences,
  type OpenTabsEntry,
  type ResolvedPreferences,
  resolvePreferences,
  type UserPreferences,
} from '@kaxolax/contracts'

/**
 * Cumule deux modifications en attente d'envoi (fusion profonde, la seconde l'emporte). En cas
 * d'échec de validation (impossible pour deux modifications valides), la seconde seule est gardée.
 */
export function combinePatches(first: UserPreferences, second: UserPreferences): UserPreferences {
  try {
    return mergePreferences(first, second)
  } catch {
    return second
  }
}

/** Préférences complètes après une modification locale (mise à jour optimiste). */
export function applyPatch(
  current: ResolvedPreferences,
  patch: UserPreferences,
): ResolvedPreferences {
  try {
    return resolvePreferences(mergePreferences(current, patch))
  } catch {
    return current
  }
}

/** Onglets ouverts d'un projet : ids (documents ou fichiers) dans l'ordre, et l'onglet actif. */
export interface TabsState {
  ids: string[]
  active: string | null
}

export const EMPTY_TABS: TabsState = { ids: [], active: null }

/**
 * Ouvre (ou active) un onglet, inséré à droite de l'onglet actif. Au-delà de
 * `MAX_OPEN_TABS_PER_PROJECT`, les onglets les plus à gauche (sauf le nouveau) sont fermés.
 */
export function openTab(state: TabsState, id: string): TabsState {
  if (state.ids.includes(id)) return state.active === id ? state : { ids: state.ids, active: id }
  const index = state.active === null ? -1 : state.ids.indexOf(state.active)
  const ids = [...state.ids]
  ids.splice(index === -1 ? ids.length : index + 1, 0, id)
  while (ids.length > MAX_OPEN_TABS_PER_PROJECT) {
    const victim = ids.findIndex((candidate) => candidate !== id)
    ids.splice(victim, 1)
  }
  return { ids, active: id }
}

/** Ferme un onglet ; s'il était actif, son voisin de droite (sinon de gauche) devient actif. */
export function closeTab(state: TabsState, id: string): TabsState {
  const index = state.ids.indexOf(id)
  if (index === -1) return state
  const ids = state.ids.filter((candidate) => candidate !== id)
  if (state.active !== id) return { ids, active: state.active }
  return { ids, active: ids[index] ?? ids[index - 1] ?? null }
}

/** Retire les onglets des entités qui n'existent plus (suppression, autre utilisateur). */
export function pruneTabs(state: TabsState, exists: (id: string) => boolean): TabsState {
  const ids = state.ids.filter(exists)
  if (ids.length === state.ids.length) return state
  const active = state.active !== null && exists(state.active) ? state.active : (ids[0] ?? null)
  return { ids, active }
}

/**
 * Onglets à l'ouverture d'un projet : ceux mémorisés qui existent encore, sinon le document
 * principal (`fallback`).
 */
export function restoreTabs(
  entry: OpenTabsEntry | undefined,
  exists: (id: string) => boolean,
  fallback: string | null,
): TabsState {
  const restored = pruneTabs(
    { ids: entry?.documentIds ?? [], active: entry?.activeDocumentId ?? null },
    exists,
  )
  if (restored.ids.length > 0) {
    return restored.active === null ? { ...restored, active: restored.ids[0] ?? null } : restored
  }
  return fallback === null ? EMPTY_TABS : { ids: [fallback], active: fallback }
}

/** Valeur mémorisée dans les préférences (`openTabs[projectId]`). */
export function tabsEntry(state: TabsState): OpenTabsEntry {
  return { documentIds: state.ids, activeDocumentId: state.active }
}
