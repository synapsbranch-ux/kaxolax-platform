'use client'

import { type ActiveBanner, BANNER_POLL_INTERVAL_MS, type BannerLevel } from '@kaxolax/contracts'
import { cn } from '@kaxolax/ui'
import { Info, TriangleAlert, Wrench, X } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { api } from '@/lib/api'
import { bannerFeed } from '@/lib/project-events'

/** Bannières fermées pendant cette session du navigateur (sessionStorage). */
const DISMISSED_KEY = 'kaxolax:dismissed-banners'

/**
 * Clé de fermeture : la bannière telle qu'elle a été lue. Une modification (niveau ou message)
 * garde le même id mais change la clé : la bannière réapparaît.
 */
function dismissalKey(banner: ActiveBanner): string {
  return JSON.stringify([banner.id, banner.level, banner.message])
}

function readDismissed(): string[] {
  try {
    const value: unknown = JSON.parse(sessionStorage.getItem(DISMISSED_KEY) ?? '[]')
    return Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : []
  } catch {
    return []
  }
}

function writeDismissed(ids: string[]): void {
  try {
    sessionStorage.setItem(DISMISSED_KEY, JSON.stringify(ids))
  } catch {
    // Stockage indisponible (navigation privée stricte) : la fermeture vaut pour cette page.
  }
}

const LEVELS: Record<BannerLevel, { className: string; icon: typeof Info; label: string }> = {
  info: { className: 'bg-blue-600 text-white', icon: Info, label: 'Information' },
  warning: { className: 'bg-amber-400 text-black', icon: TriangleAlert, label: 'Avertissement' },
  maintenance: { className: 'bg-red-600 text-white', icon: Wrench, label: 'Maintenance' },
}

/**
 * Bannières système (publiées depuis l'admin). Reçues en direct sur la page projet (événement
 * `banner.changed` du document meta, relayé par `bannerFeed`) ; relues aussi toutes les 60 s et
 * au retour sur l'onglet, en filet (tableau de bord, connexion temps réel coupée).
 * Chaque bannière se ferme pour la session du navigateur, jusqu'à sa prochaine modification.
 * Affichées en haut de l'application, en bandeau fixe pleine largeur : elles n'ajoutent aucune
 * hauteur aux pages en plein écran (éditeur en `h-screen`) et se ferment d'un clic. La nouvelle
 * interface (tâche 3) pourra leur réserver une place dans sa mise en page.
 */
export function SystemBanner() {
  const [banners, setBanners] = useState<ActiveBanner[]>([])
  // Au rendu serveur, rien n'est affiché tant que les bannières ne sont pas chargées : lire
  // sessionStorage dès le premier rendu client ne crée pas d'écart d'hydratation.
  const [dismissed, setDismissed] = useState<string[]>(() =>
    typeof window === 'undefined' ? [] : readDismissed(),
  )

  const refresh = useCallback(() => {
    api.activeBanners().then(
      (response) => {
        setBanners(response.banners)
      },
      // Erreur passagère ou session fermée : on garde l'affichage actuel.
      () => undefined,
    )
  }, [])

  useEffect(() => {
    refresh()
    const unsubscribe = bannerFeed.subscribe(setBanners)
    const interval = setInterval(refresh, BANNER_POLL_INTERVAL_MS)
    const onVisible = () => {
      if (document.visibilityState === 'visible') refresh()
    }
    document.addEventListener('visibilitychange', onVisible)
    window.addEventListener('focus', refresh)
    return () => {
      unsubscribe()
      clearInterval(interval)
      document.removeEventListener('visibilitychange', onVisible)
      window.removeEventListener('focus', refresh)
    }
  }, [refresh])

  const visible = banners.filter((banner) => !dismissed.includes(dismissalKey(banner)))
  if (visible.length === 0) return null

  return (
    <div role="region" aria-label="Annonces" className="fixed inset-x-0 top-0 z-50 flex flex-col">
      {visible.map((banner) => {
        const { className, icon: Icon, label } = LEVELS[banner.level]
        return (
          <div
            key={banner.id}
            role={banner.level === 'info' ? 'status' : 'alert'}
            className={cn('flex w-full items-center gap-3 px-4 py-2 text-sm shadow-md', className)}
          >
            <Icon className="size-4 shrink-0" aria-label={label} />
            <p className="min-w-0 flex-1">{banner.message}</p>
            <button
              type="button"
              className="rounded p-1 hover:bg-black/10"
              aria-label="Fermer l'annonce"
              onClick={() => {
                // Seules les clés des bannières encore publiées sont gardées.
                const current = new Set(banners.map(dismissalKey))
                const next = [...dismissed.filter((key) => current.has(key)), dismissalKey(banner)]
                setDismissed(next)
                writeDismissed(next)
              }}
            >
              <X className="size-4" aria-hidden />
            </button>
          </div>
        )
      })}
    </div>
  )
}
