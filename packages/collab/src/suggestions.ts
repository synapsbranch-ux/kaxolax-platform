import {
  SUGGESTION_TEXT_MAX_LENGTH,
  type SuggestionApplyOutcome,
  type SuggestionKind,
} from '@kaxolax/contracts'
import * as Y from 'yjs'
import {
  anchorFromBase64,
  anchorToBase64,
  createCommentAnchor,
  createPointAnchor,
  decodeCommentAnchor,
  isPointAnchor,
  resolveCommentAnchor,
} from './anchors.js'

/**
 * Suivi des modifications : conversion des frappes du mode Suggérer en suggestions, résolution de
 * leurs ancres dans le texte courant, application d'une suggestion acceptée. Fonctions pures sur
 * un `Y.Text` (seule `applySuggestion` le modifie).
 *
 * Ancres au format des commentaires (`anchors.ts`) : la plage du texte d'origine pour une
 * suppression ou un remplacement (début attaché au premier caractère, fin au dernier) ; pour une
 * insertion, un point (début = fin) attaché au caractère qui suit, ou à la fin du texte.
 */

/** Map Yjs des suggestions déjà appliquées au document (identifiant → décideur). */
export const APPLIED_SUGGESTIONS_FIELD = 'appliedSuggestions'

/** Modification proposée, ancrée dans le texte (base de la création ou de la modification). */
export interface PendingSuggestion {
  /** Suggestion déjà enregistrée (modification par `PATCH`) ; absent : à créer. */
  id?: string
  authorId: string
  kind: SuggestionKind
  /** Ancre encodée (`anchorToBase64` pour l'API). */
  anchor: Uint8Array
  originalText: string
  proposedText: string
}

/**
 * Une frappe saisie en mode Suggérer, en coordonnées de la vue : le texte courant dans lequel la
 * suggestion en cours (`current` de `recordSuggestionEdit`) est affichée appliquée. Remplace
 * [from, to[ par `insert` (unités UTF-16, comme une modification CodeMirror).
 */
export interface SuggestionEdit {
  from: number
  to: number
  insert: string
}

/** Type d'une modification, ou null si elle ne change rien. */
export function suggestionKindOf(
  originalText: string,
  proposedText: string,
): SuggestionKind | null {
  if (originalText === proposedText) return null
  if (originalText === '') return 'insert'
  if (proposedText === '') return 'delete'
  return 'replace'
}

/**
 * Vrai si l'ancre se lit et a la forme attendue pour le type : un point pour une insertion, une
 * plage (début ≠ fin) pour une suppression ou un remplacement.
 */
export function isSuggestionAnchorValid(kind: SuggestionKind, bytes: Uint8Array): boolean {
  if (decodeCommentAnchor(bytes) === null) return false
  return isPointAnchor(bytes) === (kind === 'insert')
}

/** Suggestion telle que stockée : de quoi la résoudre dans le texte courant. */
export interface AnchoredSuggestion {
  kind: SuggestionKind
  /** Ancre encodée, ou en base64 (réponse de l'API). */
  anchor: Uint8Array | string
  originalText: string
}

/** Où se trouve une suggestion dans le texte courant. */
export type SuggestionResolution =
  /** Applicable : remplacer [from, to[ (vide pour une insertion) par le texte proposé. */
  | { status: 'open'; from: number; to: number }
  /**
   * Obsolète : le texte d'origine a changé (`changed`) ou a disparu (`detached`) ; `at` : où il se
   * trouvait.
   */
  | { status: 'stale'; reason: 'changed' | 'detached'; at: number }
  /**
   * Positions inconnues de ce document : mise à jour pas encore reçue côté navigateur ; ancre
   * illisible ou d'un autre document côté serveur (alors obsolète).
   */
  | { status: 'unknown' }

function anchorBytes(anchor: Uint8Array | string): Uint8Array | null {
  return typeof anchor === 'string' ? anchorFromBase64(anchor) : anchor
}

/**
 * Vrai si le contexte d'un point d'insertion a disparu : le caractère auquel il est attaché et son
 * voisin de l'autre côté du point (le précédent pour un point attaché au caractère suivant, le
 * suivant pour un point de fin de texte) sont tous deux supprimés. Yjs ramène alors la position là
 * où ces caractères se trouvaient (un paragraphe effacé, par exemple). Un seul caractère supprimé
 * (une coquille corrigée à côté du point) laisse l'insertion applicable, de même qu'un point en
 * début ou en fin de texte dont seul le caractère voisin a disparu. Une position sans caractère
 * (texte vide) n'est jamais détachée.
 */
function isPointDetached(doc: Y.Doc, position: Y.RelativePosition): boolean {
  const id = position.item
  if (id === null) return false
  const struct = Y.getItem(doc.store, id)
  if (!(struct instanceof Y.Item)) return true
  const gone = (item: Y.Item) => item.deleted && item.redone === null
  // Voisin absent : début ou fin du texte, une limite qui ne disparaît pas.
  const neighbourGone = (item: Y.Item | null) => item !== null && gone(item)
  if (!gone(struct)) return false
  const last = struct.id.clock + struct.length - 1
  if (position.assoc < 0) {
    // Point de fin de texte, attaché au caractère qui le précède : voisin = caractère suivant.
    return id.clock < last ? true : neighbourGone(struct.right)
  }
  // Point attaché au caractère qui le suit : voisin = caractère précédent.
  return id.clock > struct.id.clock ? true : neighbourGone(struct.left)
}

/** Résout une suggestion dans le texte courant et détecte qu'elle est devenue obsolète. */
export function resolveSuggestion(
  text: Y.Text,
  suggestion: AnchoredSuggestion,
): SuggestionResolution {
  const bytes = anchorBytes(suggestion.anchor)
  if (bytes === null || !isSuggestionAnchorValid(suggestion.kind, bytes)) {
    return { status: 'unknown' }
  }
  if (suggestion.kind === 'insert') {
    const anchor = decodeCommentAnchor(bytes)
    const doc = text.doc
    if (anchor === null || doc === null) return { status: 'unknown' }
    const at = Y.createAbsolutePositionFromRelativePosition(anchor.start, doc)
    if (at?.type !== text) return { status: 'unknown' }
    // Texte autour du point effacé : l'insertion n'a plus de contexte, elle est obsolète.
    if (isPointDetached(doc, anchor.start)) {
      return { status: 'stale', reason: 'detached', at: at.index }
    }
    return { status: 'open', from: at.index, to: at.index }
  }
  const range = resolveCommentAnchor(text, bytes)
  if (range.status === 'unknown') return range
  if (range.status === 'detached') return { status: 'stale', reason: 'detached', at: range.at }
  if (text.toJSON().slice(range.from, range.to) !== suggestion.originalText) {
    return { status: 'stale', reason: 'changed', at: range.from }
  }
  return { status: 'open', from: range.from, to: range.to }
}

/** Ancre de la plage [from, to[ (point si vide) pour une suggestion. */
function anchorFor(text: Y.Text, from: number, to: number): Uint8Array {
  return from === to ? createPointAnchor(text, from) : createCommentAnchor(text, from, to)
}

/**
 * Suggestion minimale qui remplace [from, to[ du texte courant `base` par `proposed` : préfixe et
 * suffixe communs retirés. Null si rien ne change.
 */
function pendingFor(
  text: Y.Text,
  base: string,
  authorId: string,
  from: number,
  to: number,
  proposed: string,
  id: string | undefined,
): PendingSuggestion | null {
  let original = base.slice(from, to)
  let start = from
  let end = to
  let prefix = 0
  while (
    prefix < original.length &&
    prefix < proposed.length &&
    original[prefix] === proposed[prefix]
  ) {
    prefix++
  }
  let suffix = 0
  while (
    suffix < original.length - prefix &&
    suffix < proposed.length - prefix &&
    original[original.length - 1 - suffix] === proposed[proposed.length - 1 - suffix]
  ) {
    suffix++
  }
  start += prefix
  end -= suffix
  original = original.slice(prefix, original.length - suffix)
  const next = proposed.slice(prefix, proposed.length - suffix)
  const kind = suggestionKindOf(original, next)
  if (kind === null) return null
  return {
    ...(id === undefined ? {} : { id }),
    authorId,
    kind,
    anchor: anchorFor(text, start, end),
    originalText: original,
    proposedText: next,
  }
}

/** Résultat d'une frappe en mode Suggérer. */
export interface RecordedSuggestionEdit {
  /**
   * Suggestion en cours après la frappe (null : la frappe a annulé la suggestion en cours, ou a été
   * refusée).
   */
  pending: PendingSuggestion | null
  /**
   * Suggestion précédente terminée, à enregistrer telle quelle : la frappe ne la prolonge pas
   * (autre endroit, autre auteur, suggestion obsolète, texte trop long).
   */
  finished: PendingSuggestion | null
  /**
   * Suggestion en cours fusionnée puis annulée (frappe effacée) : si elle était déjà enregistrée
   * (`id`), la retirer (`DELETE`).
   */
  cancelled: PendingSuggestion | null
  /** Frappe ignorée : le texte d'origine ou proposé dépasserait `SUGGESTION_TEXT_MAX_LENGTH`. */
  rejected: boolean
}

const tooLong = (pending: PendingSuggestion | null) =>
  pending !== null &&
  (pending.originalText.length > SUGGESTION_TEXT_MAX_LENGTH ||
    pending.proposedText.length > SUGGESTION_TEXT_MAX_LENGTH)

/**
 * Convertit une frappe du mode Suggérer en suggestion et la fusionne avec la suggestion en cours
 * (`current`) quand elle est du même auteur et contiguë : touche ou recouvre la zone de la
 * suggestion dans la vue. Le texte (`text`) n'est pas modifié.
 *
 * Coordonnées de `edit` : la vue, c'est-à-dire le texte courant avec `current` appliquée (texte
 * proposé affiché à la place du texte d'origine). Sans suggestion en cours, ou si elle est
 * obsolète ou introuvable, la vue est le texte courant. Une frappe qui ne prolonge pas `current`
 * la termine (`finished`) et en commence une nouvelle.
 */
export function recordSuggestionEdit(
  text: Y.Text,
  current: PendingSuggestion | null,
  authorId: string,
  edit: SuggestionEdit,
): RecordedSuggestionEdit {
  const base = text.toJSON()
  // La vue contient la suggestion en cours si elle est de cet auteur et encore applicable.
  const resolved =
    current !== null && current.authorId === authorId ? resolveSuggestion(text, current) : null
  const draft =
    current !== null && resolved?.status === 'open'
      ? { from: resolved.from, to: resolved.to, proposed: current.proposedText }
      : null
  const draftFrom = draft?.from ?? 0
  const draftTo = draft?.to ?? 0
  const proposedLength = draft?.proposed.length ?? 0
  const draftViewEnd = draftFrom + proposedLength
  const viewLength = base.length - (draftTo - draftFrom) + proposedLength
  if (
    !Number.isInteger(edit.from) ||
    !Number.isInteger(edit.to) ||
    edit.from < 0 ||
    edit.to < edit.from ||
    edit.to > viewLength
  ) {
    throw new RangeError('Edit range outside of the text')
  }
  /** Position de la vue située après la zone en cours, ramenée au texte courant. */
  const afterDraft = (position: number) => position - proposedLength + (draftTo - draftFrom)

  if (draft !== null && current !== null && edit.from <= draftViewEnd && edit.to >= draftFrom) {
    // Frappe contiguë : la zone fusionnée couvre la suggestion en cours et la frappe.
    const viewStart = Math.min(edit.from, draftFrom)
    const viewEnd = Math.max(edit.to, draftViewEnd)
    const baseEnd = afterDraft(viewEnd)
    const segment = base.slice(viewStart, draftFrom) + draft.proposed + base.slice(draftTo, baseEnd)
    const proposed =
      segment.slice(0, edit.from - viewStart) + edit.insert + segment.slice(edit.to - viewStart)
    const merged = pendingFor(text, base, authorId, viewStart, baseEnd, proposed, current.id)
    if (tooLong(merged)) {
      return { pending: current, finished: null, cancelled: null, rejected: true }
    }
    return {
      pending: merged,
      finished: null,
      cancelled: merged === null ? current : null,
      rejected: false,
    }
  }

  // Ailleurs, ou suggestion en cours d'un autre auteur, obsolète ou introuvable : elle est
  // terminée et la frappe en commence une nouvelle.
  const shift =
    draft !== null && edit.from > draftViewEnd ? afterDraft : (position: number) => position
  const pending = pendingFor(
    text,
    base,
    authorId,
    shift(edit.from),
    shift(edit.to),
    edit.insert,
    undefined,
  )
  if (tooLong(pending)) return { pending: null, finished: current, cancelled: null, rejected: true }
  return { pending, finished: current, cancelled: null, rejected: false }
}

/** Charge utile de l'API (création ou modification) d'une suggestion en cours. */
export function pendingSuggestionInput(pending: PendingSuggestion): {
  kind: SuggestionKind
  anchor: string
  originalText: string
  proposedText: string
} {
  return {
    kind: pending.kind,
    anchor: anchorToBase64(pending.anchor),
    originalText: pending.originalText,
    proposedText: pending.proposedText,
  }
}

/** Suggestion acceptée à appliquer au texte. */
export interface AcceptedSuggestion extends AnchoredSuggestion {
  id: string
  proposedText: string
}

/**
 * Applique une suggestion acceptée au texte, dans une transaction Yjs d'origine `origin` (le
 * service temps réel y met l'auteur de la suggestion : le journal de l'historique lui attribue la
 * modification). Appelée dans une transaction déjà ouverte, elle en garde l'origine.
 *
 * Idempotente : l'identifiant est noté dans la map `APPLIED_SUGGESTIONS_FIELD` du document dans la
 * même transaction ; un second appel répond `already-applied` sans rien changer. Une suggestion
 * obsolète ou introuvable (`stale`) n'est pas appliquée.
 */
export function applySuggestion(
  text: Y.Text,
  suggestion: AcceptedSuggestion,
  options: { decidedBy: string; origin?: unknown },
): SuggestionApplyOutcome {
  const doc = text.doc
  if (doc === null) throw new Error('The text is not part of a document')
  let outcome: SuggestionApplyOutcome = 'stale'
  doc.transact(() => {
    const applied = doc.getMap<string>(APPLIED_SUGGESTIONS_FIELD)
    if (applied.has(suggestion.id)) {
      outcome = 'already-applied'
      return
    }
    const resolution = resolveSuggestion(text, suggestion)
    if (resolution.status !== 'open') return
    if (resolution.to > resolution.from)
      text.delete(resolution.from, resolution.to - resolution.from)
    if (suggestion.proposedText !== '') text.insert(resolution.from, suggestion.proposedText)
    applied.set(suggestion.id, options.decidedBy)
    outcome = 'applied'
  }, options.origin ?? null)
  return outcome
}
