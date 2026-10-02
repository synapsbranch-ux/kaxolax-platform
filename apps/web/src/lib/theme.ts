import type { Theme } from '@kaxolax/contracts'

/**
 * Cookie qui recopie la préférence de thème : le layout racine (serveur) le lit pour rendre
 * `data-theme` dès le HTML, sans flash, même sur un appareil dont le localStorage est vide.
 */
export const THEME_COOKIE = 'kaxolax-theme'

/** Thème lu dans le cookie (valeur inconnue ou absente : null). */
export function parseThemeCookie(value: string | undefined): Theme | null {
  return value === 'dark' || value === 'light' ? value : null
}

/** En-tête `document.cookie` qui mémorise le thème un an pour tout le site. */
export function themeCookie(theme: Theme): string {
  return `${THEME_COOKIE}=${theme}; path=/; max-age=31536000; samesite=lax`
}
