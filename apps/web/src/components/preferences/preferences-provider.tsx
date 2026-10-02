'use client'

import {
  DEFAULT_PREFERENCES,
  type ResolvedPreferences,
  type UserPreferences,
} from '@kaxolax/contracts'
import { applyThemePreference } from '@kaxolax/ui'
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { api } from '@/lib/api'
import { applyPatch, combinePatches } from '@/lib/preferences'
import { themeCookie } from '@/lib/theme'

/** Délai sans modification avant l'envoi des préférences à l'API (tailles de colonnes, onglets…). */
const SAVE_DELAY_MS = 800

interface PreferencesContextValue {
  /** Préférences complètes : celles de l'API, défauts appliqués, plus les modifications locales. */
  preferences: ResolvedPreferences
  /** Vrai une fois la réponse de l'API reçue (ou en échec : les défauts restent en place). */
  loaded: boolean
  /** Modification partielle, appliquée tout de suite et envoyée par `PATCH` après une pause. */
  update: (patch: UserPreferences) => void
}

const PreferencesContext = createContext<PreferencesContextValue | null>(null)

/**
 * Préférences de l'utilisateur (`GET /me/preferences`), communes à tous ses appareils. Les
 * modifications sont optimistes et regroupées (anti-rebond) avant `PATCH /me/preferences` ; le
 * thème est appliqué à <html> et recopié dans un cookie (rendu serveur sans flash).
 */
export function PreferencesProvider({ children }: { children: ReactNode }) {
  const [preferences, setPreferences] = useState<ResolvedPreferences>(DEFAULT_PREFERENCES)
  const [loaded, setLoaded] = useState(false)
  // Modification pas encore envoyée, et minuterie de l'envoi.
  const pending = useRef<UserPreferences | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Numéro du dernier envoi : seule sa réponse est appliquée (les réponses peuvent se croiser).
  const sent = useRef(0)
  // Envois enchaînés : chaque PATCH part après la réponse du précédent, dans l'ordre des
  // modifications (l'API les applique alors dans cet ordre).
  const queue = useRef<Promise<unknown>>(Promise.resolve())
  // PATCH de la file pas encore terminés : un envoi `keepalive` hors file pourrait les doubler.
  const inFlight = useRef(0)
  // Envoi `keepalive` parti pendant un PATCH en cours (page quittée) : ordre d'arrivée incertain,
  // l'état est relu auprès de l'API si la page redevient visible (retour arrière, bfcache).
  const rereadOnShow = useRef(false)

  /** Retire la modification en attente et arrête la minuterie. */
  const takePending = useCallback((): UserPreferences | null => {
    if (timer.current !== null) {
      clearTimeout(timer.current)
      timer.current = null
    }
    const patch = pending.current
    pending.current = null
    return patch
  }, [])

  const flush = useCallback(() => {
    const patch = takePending()
    if (patch === null) return
    const sequence = ++sent.current
    const latest = () => sequence === sent.current
    inFlight.current += 1
    const request = queue.current.then(() => api.updatePreferences(patch))
    const settled = () => {
      inFlight.current -= 1
    }
    queue.current = request.then(settled, settled)
    request.then(
      ({ preferences: saved }) => {
        // Rien de neuf entre-temps : la réponse de l'API fait foi.
        if (latest() && pending.current === null) setPreferences(saved)
      },
      () => {
        // Refusée (validation, réseau) : retour à l'état enregistré, modifications suivantes
        // comprises. Un envoi plus récent, s'il y en a un, réconcilie lui-même l'état.
        if (!latest()) return
        void api.preferences().then(
          ({ preferences: saved }) => {
            if (!latest()) return
            setPreferences(pending.current === null ? saved : applyPatch(saved, pending.current))
          },
          () => undefined,
        )
      },
    )
  }, [takePending])

  /**
   * Page masquée ou quittée : envoi immédiat, synchrone et `keepalive` (une requête qui attend
   * encore un jeton serait abandonnée avec la page). Sans jeton récent, envoi ordinaire. Si un
   * PATCH est encore en cours, seul l'envoi par la file garde l'ordre : onglet simplement masqué
   * (la page vit encore), la minuterie l'enverra par la file ; page quittée, `keepalive` malgré
   * tout (sinon perdu), puis relecture si la page revient.
   */
  const flushOnExit = useCallback(
    (leaving: boolean) => {
      const patch = pending.current
      if (patch === null) return
      const busy = inFlight.current > 0
      if (busy && !leaving) return
      if (api.updatePreferencesOnExit(patch)) {
        takePending()
        sent.current += 1
        if (busy) rereadOnShow.current = true
      } else flush()
    },
    [flush, takePending],
  )

  /** Relit les préférences enregistrées après un envoi `keepalive` d'ordre incertain. */
  const rereadAfterExit = useCallback(() => {
    if (!rereadOnShow.current) return
    rereadOnShow.current = false
    const sequence = sent.current
    // Après les PATCH encore dans la file : leur réponse est ignorée (`sent` a avancé).
    void queue.current
      .then(() => api.preferences())
      .then(
        ({ preferences: saved }) => {
          if (sequence !== sent.current) return
          setPreferences(pending.current === null ? saved : applyPatch(saved, pending.current))
        },
        () => undefined,
      )
  }, [])

  useEffect(() => {
    let active = true
    api.preferences().then(
      ({ preferences: saved }) => {
        if (!active) return
        // Modifications faites avant la réponse : appliquées par-dessus.
        setPreferences(pending.current === null ? saved : applyPatch(saved, pending.current))
        setLoaded(true)
      },
      () => {
        if (active) setLoaded(true)
      },
    )
    return () => {
      active = false
    }
  }, [])

  // Envoi immédiat quand la page est masquée ou quittée, et au démontage ; relecture au retour si
  // nécessaire.
  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') flushOnExit(false)
      else rereadAfterExit()
    }
    const onPageHide = () => {
      flushOnExit(true)
    }
    document.addEventListener('visibilitychange', onVisibility)
    window.addEventListener('pagehide', onPageHide)
    window.addEventListener('pageshow', rereadAfterExit)
    return () => {
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('pagehide', onPageHide)
      window.removeEventListener('pageshow', rereadAfterExit)
      flush()
    }
  }, [flush, flushOnExit, rereadAfterExit])

  // Thème : appliqué une fois les préférences connues (avant, le script de <head> l'a posé).
  useEffect(() => {
    if (!loaded) return
    applyThemePreference(preferences.theme)
    document.cookie = themeCookie(preferences.theme)
  }, [loaded, preferences.theme])

  const update = useCallback(
    (patch: UserPreferences) => {
      setPreferences((current) => applyPatch(current, patch))
      if (pending.current === null) {
        // Jeton frais gardé pour un envoi pendant la fermeture de la page (voir flushOnExit).
        void api.warmToken().catch(() => undefined)
      }
      pending.current = pending.current === null ? patch : combinePatches(pending.current, patch)
      if (timer.current !== null) clearTimeout(timer.current)
      timer.current = setTimeout(flush, SAVE_DELAY_MS)
    },
    [flush],
  )

  const value = useMemo(() => ({ preferences, loaded, update }), [preferences, loaded, update])
  return <PreferencesContext value={value}>{children}</PreferencesContext>
}

/** Préférences de l'utilisateur et leur modification (voir `PreferencesProvider`). */
export function usePreferences(): PreferencesContextValue {
  const value = useContext(PreferencesContext)
  if (value === null) throw new Error('usePreferences must be used inside PreferencesProvider')
  return value
}
