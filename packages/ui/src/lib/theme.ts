/** Thème appliqué : valeur de l'attribut `data-theme` de <html>. */
export type Theme = 'light' | 'dark'

/** Préférence de l'utilisateur (paramètres) ; `system` suit le système d'exploitation. */
export type ThemePreference = Theme | 'system'

export interface ThemeOptions {
  /** Clé localStorage qui mémorise la préférence sur l'appareil. */
  storageKey?: string
  /** Préférence sans valeur connue (sombre, comme le concept). */
  defaultPreference?: ThemePreference
}

export const THEME_STORAGE_KEY = 'kaxolax:theme'
export const DEFAULT_THEME_PREFERENCE: ThemePreference = 'dark'
/** Attribut de <html> qui porte la préférence rendue par le serveur (prioritaire sur localStorage). */
export const THEME_PREFERENCE_ATTRIBUTE = 'data-theme-preference'

const DARK_QUERY = '(prefers-color-scheme: dark)'

export function isThemePreference(value: unknown): value is ThemePreference {
  return value === 'light' || value === 'dark' || value === 'system'
}

/** Thème effectif d'une préférence. */
export function resolveTheme(preference: ThemePreference, systemPrefersDark: boolean): Theme {
  if (preference === 'system') return systemPrefersDark ? 'dark' : 'light'
  return preference
}

/**
 * Code JavaScript à exécuter dans <head> avant le premier rendu : lit la préférence (attribut
 * `data-theme-preference` de <html>, sinon localStorage, sinon le défaut) et pose `data-theme`
 * et `color-scheme` sur <html>, sans flash du mauvais thème.
 */
export function themeScript(options: ThemeOptions = {}): string {
  const storageKey = options.storageKey ?? THEME_STORAGE_KEY
  const fallback = isThemePreference(options.defaultPreference)
    ? options.defaultPreference
    : DEFAULT_THEME_PREFERENCE
  // JSON échappé : aucune valeur ne peut fermer la balise <script>.
  const json = (value: string) => JSON.stringify(value).replace(/</g, '\\u003c')
  return (
    '(function(){try{' +
    'var d=document.documentElement,k=' +
    json(storageKey) +
    ',f=' +
    json(fallback) +
    ',v=function(p){return p==="light"||p==="dark"||p==="system"};' +
    'var p=d.getAttribute(' +
    json(THEME_PREFERENCE_ATTRIBUTE) +
    ');if(!v(p)){try{p=localStorage.getItem(k)}catch(e){p=null}}if(!v(p))p=f;' +
    'var t=p==="system"?(matchMedia(' +
    json(DARK_QUERY) +
    ').matches?"dark":"light"):p;' +
    'd.setAttribute("data-theme",t);d.style.colorScheme=t' +
    '}catch(e){}})()'
  )
}

/** Le système préfère-t-il le sombre ? `false` côté serveur. */
export function systemPrefersDark(): boolean {
  return typeof window !== 'undefined' && window.matchMedia(DARK_QUERY).matches
}

/**
 * Applique une préférence dans le navigateur (changement dans les paramètres) : attributs de
 * <html> et copie dans localStorage pour le prochain chargement. Renvoie le thème appliqué.
 */
export function applyThemePreference(
  preference: ThemePreference,
  options: ThemeOptions = {},
): Theme {
  const theme = resolveTheme(preference, systemPrefersDark())
  const root = document.documentElement
  root.setAttribute(THEME_PREFERENCE_ATTRIBUTE, preference)
  root.setAttribute('data-theme', theme)
  root.style.colorScheme = theme
  try {
    localStorage.setItem(options.storageKey ?? THEME_STORAGE_KEY, preference)
  } catch {
    // Stockage indisponible (navigation privée) : la préférence vaut pour cette page seulement.
  }
  return theme
}

/**
 * Prévient à chaque changement du thème du système (préférence `system`).
 * Renvoie la fonction de désabonnement.
 */
export function subscribeSystemTheme(callback: (theme: Theme) => void): () => void {
  const query = window.matchMedia(DARK_QUERY)
  const listener = (event: MediaQueryListEvent) => {
    callback(event.matches ? 'dark' : 'light')
  }
  query.addEventListener('change', listener)
  return () => {
    query.removeEventListener('change', listener)
  }
}
