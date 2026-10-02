/** Nombre de couleurs de présence définies dans tokens.css (`--presence-1` à `--presence-8`). */
export const PRESENCE_COLOR_COUNT = 8

/**
 * Index de couleur de présence (0 à 7) stable pour une clé, en général l'id de l'utilisateur :
 * tous les clients attribuent la même couleur au même collaborateur, sans coordination.
 * Hachage FNV-1a 32 bits.
 */
export function presenceColorIndex(key: string): number {
  let hash = 0x811c9dc5
  for (let i = 0; i < key.length; i++) {
    hash ^= key.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0) % PRESENCE_COLOR_COUNT
}

/**
 * Valeur CSS de la couleur de présence `index` (pris modulo 8), qui suit le thème courant.
 * Avec `opacity` (0 à 1), une version transparente (fond de sélection d'un collaborateur).
 */
export function presenceColor(index: number, opacity?: number): string {
  const n = Number.isFinite(index) ? Math.trunc(index) : 0
  const slot = (((n % PRESENCE_COLOR_COUNT) + PRESENCE_COLOR_COUNT) % PRESENCE_COLOR_COUNT) + 1
  const color = `var(--presence-${slot})`
  if (opacity === undefined) return color
  const percent = Math.round(Math.min(1, Math.max(0, opacity)) * 100)
  return `color-mix(in oklab, ${color} ${percent}%, transparent)`
}

export interface AvatarStackSplit<T> {
  visible: T[]
  overflow: T[]
}

/**
 * Répartit une pile d'avatars : tout s'affiche si `items` tient dans `max` places ; sinon
 * `max - 1` avatars et une pastille « +N » qui prend la dernière place (jamais « +1 », qui
 * occuperait la place d'un avatar). `max` vaut au moins 1.
 */
export function splitAvatarStack<T>(items: readonly T[], max: number): AvatarStackSplit<T> {
  const limit = Number.isNaN(max) ? 1 : Math.max(1, Math.floor(max))
  if (items.length <= limit) return { visible: [...items], overflow: [] }
  return { visible: items.slice(0, limit - 1), overflow: items.slice(limit - 1) }
}

/** Première lettre ou chiffre d'un mot, s'il y en a. */
function firstLetter(word: string): string | undefined {
  return /[\p{L}\p{N}]/u.exec(word)?.[0]
}

/**
 * Initiales d'un nom affiché : « Ada Lovelace » → « AL », « Jean-Pierre Dupont » → « JD »,
 * « ada.lovelace@exemple.fr » → « AL », « Ada » → « A ». « ? » si rien d'utilisable.
 */
export function initialsOf(name: string): string {
  const trimmed = name.trim()
  // Adresse email seule : les initiales viennent de la partie locale.
  const base = /^\S+@\S+$/.test(trimmed) ? (trimmed.split('@')[0] ?? '') : trimmed
  const letters = base
    .split(/[\s._-]+/u)
    .map(firstLetter)
    .filter((letter): letter is string => letter !== undefined)
  const first = letters[0]
  if (first === undefined) return '?'
  const last = letters.length > 1 ? letters[letters.length - 1] : undefined
  return (first + (last ?? '')).toUpperCase()
}
