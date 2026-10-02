import { z } from 'zod'

/**
 * Présence (awareness Yjs). Chaque client publie un état `PresenceState` :
 * - sur le document meta du projet : qui est en ligne et le document ouvert (`documentId`) ;
 * - sur un document texte : la même identité et le curseur/la sélection (`cursor`, positions
 *   relatives Yjs écrites par y-codemirror.next).
 * Le service temps réel impose l'identité (`user`) de la connexion ; chaque client valide les
 * états reçus avec `parsePresenceState` et ignore les autres.
 */

/** Nombre de couleurs de présence (`--presence-1` à `--presence-8` dans packages/ui). */
export const PRESENCE_COLOR_COUNT = 8

/** Longueur maximale du nom affiché dans la présence. */
export const MAX_PRESENCE_NAME_LENGTH = 200

/**
 * Nom affiché d'un collaborateur sans nom complet : jamais son email, que la présence montrerait
 * à tous les membres (y compris un lecteur entré par le lien public).
 */
export const PRESENCE_FALLBACK_NAME = 'Collaborateur'

/** Longueur maximale de l'URL de la photo de profil (miroir Clerk). */
export const MAX_PRESENCE_AVATAR_URL_LENGTH = 2048

/** Opacité du fond de sélection d'un collaborateur (`colorLight`). */
export const PRESENCE_SELECTION_OPACITY = 0.2

/**
 * Index de couleur (0 à 7) stable pour un id d'utilisateur, par hachage FNV-1a 32 bits : même
 * calcul que `presenceColorIndex` de packages/ui (`lib/avatars.ts`), vérifié par les tests.
 */
export function presenceColorIndex(key: string): number {
  let hash = 0x811c9dc5
  for (let i = 0; i < key.length; i++) {
    hash ^= key.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0) % PRESENCE_COLOR_COUNT
}

/** Couleur CSS de l'index (variable du thème), comme `presenceColor` de packages/ui. */
export function presenceCssColor(index: number): string {
  return `var(--presence-${String(index + 1)})`
}

/** Fond de sélection de l'index, comme `presenceColor(index, 0.2)` de packages/ui. */
export function presenceCssColorLight(index: number): string {
  const percent = Math.round(PRESENCE_SELECTION_OPACITY * 100)
  return `color-mix(in oklab, ${presenceCssColor(index)} ${String(percent)}%, transparent)`
}

const PRESENCE_COLOR = /^var\(--presence-[1-8]\)$/
const PRESENCE_COLOR_LIGHT =
  /^color-mix\(in oklab, var\(--presence-[1-8]\) \d{1,3}%, transparent\)$/

/**
 * Identité d'un collaborateur. `color` et `colorLight` sont lus tels quels par y-codemirror.next
 * (curseurs et sélections distants) : seules les variables de thème sont admises.
 */
export const presenceUserSchema = z
  .object({
    id: z.uuid(),
    name: z.string().min(1).max(MAX_PRESENCE_NAME_LENGTH),
    /** Photo de profil (https seulement) ; null : initiales. */
    avatarUrl: z
      .url({ protocol: /^https$/ })
      .max(MAX_PRESENCE_AVATAR_URL_LENGTH)
      .nullable(),
    colorIndex: z
      .number()
      .int()
      .min(0)
      .max(PRESENCE_COLOR_COUNT - 1),
    color: z.string().regex(PRESENCE_COLOR),
    colorLight: z.string().regex(PRESENCE_COLOR_LIGHT),
  })
  .refine((user) => user.colorIndex === presenceColorIndex(user.id), {
    message: 'colorIndex must be derived from the user id',
    path: ['colorIndex'],
  })
export type PresenceUser = z.infer<typeof presenceUserSchema>

/** Position relative Yjs sérialisée (`Y.relativePositionToJSON`). */
const relativePositionSchema = z.looseObject({})

export const presenceCursorSchema = z.object({
  anchor: relativePositionSchema,
  head: relativePositionSchema,
})
export type PresenceCursor = z.infer<typeof presenceCursorSchema>

export const presenceStateSchema = z.looseObject({
  user: presenceUserSchema,
  /** Document ouvert (awareness du document meta) ; null : aucun. */
  documentId: z.uuid().nullable().optional(),
  /** Curseur et sélection (awareness d'un document texte) ; null : pas de focus. */
  cursor: presenceCursorSchema.nullable().optional(),
})
export type PresenceState = z.infer<typeof presenceStateSchema>

/** URL de photo de profil admise dans la présence, sinon null (autre protocole, trop longue). */
function presenceAvatarUrl(url: string | null | undefined): string | null {
  if (!url || url.length > MAX_PRESENCE_AVATAR_URL_LENGTH) return null
  try {
    return new URL(url).protocol === 'https:' ? url : null
  } catch {
    return null
  }
}

/**
 * Identité de présence d'un utilisateur : couleur dérivée de son id, nom complet tronqué (sinon
 * `PRESENCE_FALLBACK_NAME`, jamais l'email) et photo de profil https.
 */
export function presenceUserFor(
  id: string,
  fullName: string | null,
  avatarUrl: string | null = null,
): PresenceUser {
  const colorIndex = presenceColorIndex(id)
  const trimmed = (fullName ?? '').trim().slice(0, MAX_PRESENCE_NAME_LENGTH)
  return {
    id,
    name: trimmed === '' ? PRESENCE_FALLBACK_NAME : trimmed,
    avatarUrl: presenceAvatarUrl(avatarUrl),
    colorIndex,
    color: presenceCssColor(colorIndex),
    colorLight: presenceCssColorLight(colorIndex),
  }
}

/** État d'awareness reçu, validé : null s'il ne respecte pas le format (jamais de confiance). */
export function parsePresenceState(state: unknown): PresenceState | null {
  const parsed = presenceStateSchema.safeParse(state)
  return parsed.success ? parsed.data : null
}
