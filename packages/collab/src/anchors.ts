import * as Y from 'yjs'

/**
 * Ancres des commentaires : une plage de texte d'un Y.Text décrite par deux positions relatives
 * Yjs (début et fin), qui suivent le texte quelles que soient les éditions autour.
 *
 * - le début est attaché au premier caractère de la plage (`assoc` 0) et la fin au dernier
 *   (`assoc` -1) : une insertion juste avant ou juste après la plage n'y entre pas, une insertion
 *   à l'intérieur l'agrandit ;
 * - une suppression partielle réduit la plage ; si tout le texte ancré est supprimé, début et fin
 *   se rejoignent : l'ancre est « détachée » (le fil garde sa citation d'origine) ;
 * - une suppression annulée (UndoManager) rattache l'ancre au texte rétabli.
 *
 * Format binaire (colonne `comment_threads.anchor`) : un octet de version (1), la longueur de la
 * position de début sur 4 octets (big-endian), puis les deux positions encodées par Yjs
 * (`Y.encodeRelativePosition`). Transport JSON en base64.
 */

const ANCHOR_VERSION = 1
const HEADER_BYTES = 5
/** Taille maximale d'une ancre encodée (deux positions Yjs tiennent en quelques dizaines d'octets). */
export const MAX_ANCHOR_BYTES = 512

export interface DecodedAnchor {
  start: Y.RelativePosition
  end: Y.RelativePosition
}

/** Plage résolue dans le texte courant. */
export type ResolvedAnchor =
  /** Le texte ancré existe : plage [from, to[ (unités UTF-16, comme CodeMirror). */
  | { status: 'attached'; from: number; to: number }
  /** Tout le texte ancré a été supprimé : `at` est l'endroit où il se trouvait. */
  | { status: 'detached'; at: number }
  /** Positions inconnues de ce document (mise à jour pas encore reçue, autre document). */
  | { status: 'unknown' }

/**
 * Crée l'ancre de la plage [from, to[ du texte (`from` < `to`, bornes dans le texte). Lève une
 * erreur pour une plage vide ou hors du texte.
 */
export function createCommentAnchor(text: Y.Text, from: number, to: number): Uint8Array {
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to > text.length) {
    throw new RangeError('Anchor range outside of the text')
  }
  if (from >= to) throw new RangeError('Anchor range is empty')
  const start = Y.encodeRelativePosition(Y.createRelativePositionFromTypeIndex(text, from, 0))
  const end = Y.encodeRelativePosition(Y.createRelativePositionFromTypeIndex(text, to, -1))
  return encodeAnchor(start, end)
}

function encodeAnchor(start: Uint8Array, end: Uint8Array): Uint8Array {
  const bytes = new Uint8Array(HEADER_BYTES + start.length + end.length)
  bytes[0] = ANCHOR_VERSION
  new DataView(bytes.buffer).setUint32(1, start.length)
  bytes.set(start, HEADER_BYTES)
  bytes.set(end, HEADER_BYTES + start.length)
  return bytes
}

/**
 * Ancre d'un point du texte (insertion suggérée, voir `suggestions.ts`) : début et fin identiques,
 * attachés au caractère qui suit `at` (une frappe d'un autre auteur juste avant ce caractère
 * passe avant le point) ; en fin de texte, au dernier caractère (le point reste juste après lui).
 * Seul le point d'un texte vide est attaché au type lui-même. Même format que les plages.
 */
export function createPointAnchor(text: Y.Text, at: number): Uint8Array {
  if (!Number.isInteger(at) || at < 0 || at > text.length) {
    throw new RangeError('Anchor position outside of the text')
  }
  const assoc = at === text.length && at > 0 ? -1 : 0
  const position = Y.encodeRelativePosition(Y.createRelativePositionFromTypeIndex(text, at, assoc))
  return encodeAnchor(position, position)
}

/** Vrai si l'ancre se lit et désigne un point (début et fin encodés à l'identique). */
export function isPointAnchor(bytes: Uint8Array): boolean {
  if (decodeCommentAnchor(bytes) === null) return false
  const startLength = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(1)
  const start = bytes.subarray(HEADER_BYTES, HEADER_BYTES + startLength)
  const end = bytes.subarray(HEADER_BYTES + startLength)
  return start.length === end.length && start.every((byte, index) => byte === end[index])
}

/** Lit une ancre encodée : null si le format est invalide (version, longueurs, positions). */
export function decodeCommentAnchor(bytes: Uint8Array): DecodedAnchor | null {
  if (bytes.length <= HEADER_BYTES || bytes.length > MAX_ANCHOR_BYTES) return null
  if (bytes[0] !== ANCHOR_VERSION) return null
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const startLength = view.getUint32(1)
  if (startLength === 0 || HEADER_BYTES + startLength >= bytes.length) return null
  try {
    const start = Y.decodeRelativePosition(bytes.subarray(HEADER_BYTES, HEADER_BYTES + startLength))
    const end = Y.decodeRelativePosition(bytes.subarray(HEADER_BYTES + startLength))
    // Une position valide désigne un caractère (item) ou un type racine nommé.
    for (const position of [start, end]) {
      if (position.item === null && position.tname === null && position.type === null) return null
    }
    return { start, end }
  } catch {
    return null
  }
}

/** Résout une ancre dans le texte courant (voir `ResolvedAnchor`). */
export function resolveCommentAnchor(text: Y.Text, bytes: Uint8Array): ResolvedAnchor {
  const anchor = decodeCommentAnchor(bytes)
  const doc = text.doc
  if (anchor === null || doc === null) return { status: 'unknown' }
  const start = Y.createAbsolutePositionFromRelativePosition(anchor.start, doc)
  const end = Y.createAbsolutePositionFromRelativePosition(anchor.end, doc)
  if (start === null || end === null || start.type !== text || end.type !== text) {
    return { status: 'unknown' }
  }
  if (end.index <= start.index) return { status: 'detached', at: start.index }
  return { status: 'attached', from: start.index, to: end.index }
}

/** Encode une ancre en base64 (transport JSON). */
export function anchorToBase64(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

/** Lit une ancre en base64 : null si ce n'est pas du base64 valide. */
export function anchorFromBase64(value: string): Uint8Array | null {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value) || value.length % 4 !== 0) return null
  try {
    const binary = atob(value)
    const bytes = new Uint8Array(binary.length)
    for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index)
    return bytes
  } catch {
    return null
  }
}
