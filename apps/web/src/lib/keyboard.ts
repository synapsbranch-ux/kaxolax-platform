import type { KeyboardEvent } from 'react'

/**
 * Déplace le focus entre les onglets d'une liste (motif ARIA « tabs », activation manuelle) :
 * flèches gauche et droite (en boucle), Début et Fin. Renvoie vrai si la touche a été gérée.
 */
export function moveTabFocus(event: KeyboardEvent<HTMLElement>): boolean {
  const keys = ['ArrowLeft', 'ArrowRight', 'Home', 'End']
  if (!keys.includes(event.key)) return false
  const tabs = [...event.currentTarget.querySelectorAll<HTMLElement>('[role="tab"]')]
  const index = tabs.findIndex((tab) => tab === document.activeElement)
  if (index === -1 || tabs.length === 0) return false
  const next =
    event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? tabs.length - 1
        : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length
  event.preventDefault()
  tabs[next]?.focus()
  return true
}
