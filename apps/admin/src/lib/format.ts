/**
 * Heure locale du navigateur, comme les champs `datetime-local` des formulaires : une date
 * affichée se saisit telle quelle.
 */
const dateTimeFormat = new Intl.DateTimeFormat('fr-FR', { dateStyle: 'medium', timeStyle: 'short' })
const dateFormat = new Intl.DateTimeFormat('fr-FR', { dateStyle: 'medium', timeZone: 'UTC' })
const numberFormat = new Intl.NumberFormat('fr-FR')
const percentFormat = new Intl.NumberFormat('fr-FR', { style: 'percent', maximumFractionDigits: 1 })

/** Date et heure (heure locale du navigateur) ; tiret si absente. */
export function formatDateTime(iso: string | null | undefined): string {
  return iso ? dateTimeFormat.format(new Date(iso)) : '—'
}

/** Jour UTC (`2026-10-01`) en toutes lettres. */
export function formatDay(isoDay: string): string {
  return dateFormat.format(new Date(`${isoDay}T00:00:00Z`))
}

export function formatNumber(value: number): string {
  return numberFormat.format(value)
}

/** Taux entre 0 et 1 en pourcentage ; tiret si inconnu. */
export function formatRate(value: number | null): string {
  return value === null ? '—' : percentFormat.format(value)
}

/** Durée en millisecondes, lisible (`850 ms`, `12,4 s`, `3 min 05 s`) ; tiret si inconnue. */
export function formatDuration(ms: number | null): string {
  if (ms === null) return '—'
  if (ms < 1000) return `${String(Math.round(ms))} ms`
  const seconds = ms / 1000
  if (seconds < 60) return `${seconds.toFixed(1).replace('.', ',')} s`
  const minutes = Math.floor(seconds / 60)
  const rest = Math.round(seconds - minutes * 60)
  return `${String(minutes)} min ${String(rest).padStart(2, '0')} s`
}

const BYTE_UNITS = ['o', 'Ko', 'Mo', 'Go', 'To'] as const

/** Taille en octets avec l'unité adaptée (base 1024). */
export function formatBytes(bytes: number): string {
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < BYTE_UNITS.length - 1) {
    value /= 1024
    unit += 1
  }
  const digits = unit === 0 || value >= 100 ? 0 : 1
  return `${value.toFixed(digits).replace('.', ',')} ${BYTE_UNITS[unit] ?? 'o'}`
}

/**
 * Valeur d'un champ `datetime-local` (heure locale du navigateur) en ISO avec fuseau, comme
 * l'attend l'API ; null si le champ est vide ou invalide.
 */
export function localInputToIso(value: string): string | null {
  if (value.trim() === '') return null
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

/** Date ISO vers la valeur d'un champ `datetime-local` (heure locale du navigateur). */
export function isoToLocalInput(iso: string | null): string {
  if (iso === null) return ''
  const date = new Date(iso)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${String(date.getFullYear())}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
}
