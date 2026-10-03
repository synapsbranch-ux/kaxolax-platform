import type { SuggestionResolution } from '@kaxolax/collab'
import {
  canDecideSuggestion,
  canEdit,
  canSuggest,
  type DecideSuggestionsInput,
  type DecideSuggestionsResponse,
  type ProjectRole,
  SUGGESTION_ERRORS,
  type Suggestion,
  type SuggestionDecidedEvent,
} from '@kaxolax/contracts'
import { localizedErrorMessage, type ProjectTree } from './api'
import { chatMember } from './chat'

/**
 * Logique du suivi des modifications côté navigateur, sans React : mode Modifier / Suggérer
 * selon le rôle et mémorisé par projet et par utilisateur, filtres et ordre de la section
 * Suggestions du panneau Review, cible des décisions groupées, effets des événements du projet,
 * messages des résultats et des erreurs.
 */

// --- Mode Modifier / Suggérer -----------------------------------------------------------------

export type EditMode = 'edit' | 'suggest'

/** Ce que le rôle permet : choisir (éditeur, propriétaire), suggérer seulement, ou lire. */
export type EditModeChoice = 'choose' | 'suggest-only' | 'none'

export function editModeChoice(role: ProjectRole | null): EditModeChoice {
  if (role === null) return 'none'
  if (canEdit(role)) return 'choose'
  return canSuggest(role) ? 'suggest-only' : 'none'
}

/**
 * Barre Tools en lecture seule (`ActionHost.readOnly`) : sans droit d'édition, sauf en mode
 * Suggérer (relecteur), où les actions qui modifient le texte produisent des suggestions.
 */
export function actionsReadOnly(editable: boolean, mode: EditMode | null): boolean {
  return !editable && mode !== 'suggest'
}

/**
 * Mode effectif : celui mémorisé (Modifier par défaut) pour qui peut choisir, toujours Suggérer
 * pour un relecteur, null pour un lecteur (aucune bascule, éditeur en lecture seule).
 */
export function effectiveEditMode(
  role: ProjectRole | null,
  stored: EditMode | null,
): EditMode | null {
  switch (editModeChoice(role)) {
    case 'choose':
      return stored ?? 'edit'
    case 'suggest-only':
      return 'suggest'
    case 'none':
      return null
  }
}

/** Clé du stockage local du mode : par utilisateur et par projet. */
export function editModeStorageKey(userId: string, projectId: string): string {
  return `kaxolax:edit-mode:${userId}:${projectId}`
}

/** Mode mémorisé (null : jamais choisi, stockage indisponible ou valeur inconnue). */
export function readEditMode(
  storage: Pick<Storage, 'getItem'> | null,
  userId: string,
  projectId: string,
): EditMode | null {
  try {
    const value = storage?.getItem(editModeStorageKey(userId, projectId)) ?? null
    return value === 'edit' || value === 'suggest' ? value : null
  } catch {
    return null
  }
}

export function writeEditMode(
  storage: Pick<Storage, 'setItem'> | null,
  userId: string,
  projectId: string,
  mode: EditMode,
): void {
  try {
    storage?.setItem(editModeStorageKey(userId, projectId), mode)
  } catch {
    // Stockage plein ou interdit : le mode reste celui de la session.
  }
}

/** Vrai si le rôle accepte ou refuse (éditeur, propriétaire). */
export function canDecide(role: ProjectRole | null): boolean {
  return role !== null && canDecideSuggestion(role)
}

// --- Liste et filtres -------------------------------------------------------------------------

/** Suggestions affichées par le panneau : ouvertes et obsolètes (les décidées disparaissent). */
export function isListed(suggestion: Pick<Suggestion, 'status'>): boolean {
  return suggestion.status === 'open' || suggestion.status === 'stale'
}

/** Remplace (ou ajoute) une suggestion relue ; null ou décidée la retire. */
export function upsertSuggestion(
  suggestions: readonly Suggestion[],
  id: string,
  suggestion: Suggestion | null,
): Suggestion[] {
  if (suggestion === null || !isListed(suggestion)) {
    return suggestions.filter((candidate) => candidate.id !== id)
  }
  const index = suggestions.findIndex((candidate) => candidate.id === id)
  if (index < 0) return [...suggestions, suggestion]
  return suggestions.map((candidate) => (candidate.id === id ? suggestion : candidate))
}

/**
 * Rechargement complet (ouvertes puis obsolètes : deux lectures) fusionné avec la liste courante.
 * Une suggestion lue deux fois (devenue obsolète entre les deux lectures) n'apparaît qu'une fois,
 * obsolète (un statut ne revient jamais à « ouverte »). Une suggestion touchée pendant la lecture
 * (`touched` : événement reçu, action locale) garde son état courant, plus récent que la lecture.
 */
export function mergeReloaded(
  current: readonly Suggestion[],
  loaded: readonly Suggestion[],
  touched: ReadonlySet<string>,
): Suggestion[] {
  const merged = new Map<string, Suggestion>()
  for (const suggestion of loaded) {
    if (touched.has(suggestion.id) || !isListed(suggestion)) continue
    const known = merged.get(suggestion.id)
    if (known === undefined || suggestion.status === 'stale') merged.set(suggestion.id, suggestion)
  }
  for (const suggestion of current) {
    if (touched.has(suggestion.id) && !merged.has(suggestion.id)) {
      merged.set(suggestion.id, suggestion)
    }
  }
  return [...merged.values()]
}

/**
 * Effet d'un événement `suggestion.decided` : acceptées et refusées retirées, obsolètes marquées.
 */
export function applyDecisions(
  suggestions: readonly Suggestion[],
  event: Pick<SuggestionDecidedEvent, 'decisions'>,
): Suggestion[] {
  const statuses = new Map(
    event.decisions.map((decision) => [decision.suggestionId, decision.status]),
  )
  return suggestions.flatMap((suggestion) => {
    const status = statuses.get(suggestion.id)
    if (status === undefined) return [suggestion]
    return status === 'stale' ? [{ ...suggestion, status }] : []
  })
}

export interface SuggestionFilters {
  /** Auteur choisi, ou tous. */
  authorId: string | null
  /** Document choisi, ou tous. */
  documentId: string | null
}

export const NO_SUGGESTION_FILTERS: SuggestionFilters = { authorId: null, documentId: null }

export function filterSuggestions(
  suggestions: readonly Suggestion[],
  filters: SuggestionFilters,
): Suggestion[] {
  return suggestions.filter(
    (suggestion) =>
      (filters.authorId === null || suggestion.author.id === filters.authorId) &&
      (filters.documentId === null || suggestion.documentId === filters.documentId),
  )
}

export interface SuggestionAuthor {
  id: string
  name: string
  color: string
  /** Suggestions ouvertes de l'auteur. */
  open: number
}

/** Auteurs des suggestions (choix du filtre), par nom. */
export function suggestionAuthors(suggestions: readonly Suggestion[]): SuggestionAuthor[] {
  const authors = new Map<string, SuggestionAuthor>()
  for (const suggestion of suggestions) {
    const { id, fullName, avatarUrl } = suggestion.author
    const entry = authors.get(id) ?? { ...pickAuthor(id, fullName, avatarUrl), open: 0 }
    if (suggestion.status === 'open') entry.open += 1
    authors.set(id, entry)
  }
  return [...authors.values()].sort(
    (a, b) => a.name.localeCompare(b.name, 'fr') || a.id.localeCompare(b.id),
  )
}

function pickAuthor(id: string, fullName: string | null, avatarUrl: string | null) {
  const member = chatMember(id, fullName, avatarUrl)
  return { id, name: member.name, color: member.color }
}

/** Documents qui ont des suggestions (choix du filtre), par chemin. */
export function suggestionDocuments(
  suggestions: readonly Suggestion[],
  tree: Pick<ProjectTree, 'documents'> | null,
): { id: string; path: string }[] {
  const ids = new Set(suggestions.map((suggestion) => suggestion.documentId))
  return (tree?.documents ?? [])
    .filter((document) => ids.has(document.id))
    .map((document) => ({ id: document.id, path: document.path }))
    .sort((a, b) => a.path.localeCompare(b.path))
}

/** Position d'une suggestion dans le texte du document actif (null : inconnue). */
function textPosition(resolution: SuggestionResolution | undefined): number | null {
  if (resolution === undefined) return null
  if (resolution.status === 'open') return resolution.from
  if (resolution.status === 'stale') return resolution.at
  return null
}

/**
 * Ordre d'affichage et de navigation : les suggestions du document actif dans l'ordre du texte
 * (positions inconnues ensuite), puis celles des autres documents par chemin ; à égalité, par
 * date de création.
 */
export function orderSuggestions(
  suggestions: readonly Suggestion[],
  options: {
    tree: Pick<ProjectTree, 'documents'> | null
    activeDocumentId: string | null
    positions: ReadonlyMap<string, SuggestionResolution>
  },
): Suggestion[] {
  const pathOf = (documentId: string) =>
    options.tree?.documents.find((document) => document.id === documentId)?.path ?? '￿'
  const key = (suggestion: Suggestion) => {
    const active = suggestion.documentId === options.activeDocumentId
    const position = active ? textPosition(options.positions.get(suggestion.id)) : null
    return { active, position, path: pathOf(suggestion.documentId) }
  }
  return [...suggestions].sort((a, b) => {
    const left = key(a)
    const right = key(b)
    if (left.active !== right.active) return left.active ? -1 : 1
    if (left.active) {
      if (left.position !== null && right.position !== null && left.position !== right.position)
        return left.position - right.position
      if ((left.position === null) !== (right.position === null))
        return left.position === null ? 1 : -1
    } else if (left.path !== right.path) {
      return left.path.localeCompare(right.path)
    }
    return a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)
  })
}

/** Suggestion suivante (`1`) ou précédente (`-1`), en boucle ; null si la liste est vide. */
export function adjacentSuggestion(
  ordered: readonly Suggestion[],
  currentId: string | null,
  direction: 1 | -1,
): string | null {
  if (ordered.length === 0) return null
  const index = ordered.findIndex((suggestion) => suggestion.id === currentId)
  if (index < 0) return (direction === 1 ? ordered[0] : ordered.at(-1))?.id ?? null
  return ordered[(index + direction + ordered.length) % ordered.length]?.id ?? null
}

// --- Décisions --------------------------------------------------------------------------------

/**
 * Corps de « Tout accepter / Tout refuser » selon les filtres : les suggestions d'un auteur
 * (`authorId`) ou de tout le monde (`all`), restreintes au document choisi. Accepter vise les
 * ouvertes ; refuser aussi les obsolètes (écartées).
 */
export function bulkDecision(
  decision: 'accept' | 'reject',
  filters: SuggestionFilters,
): DecideSuggestionsInput {
  const scope = filters.documentId === null ? {} : { documentId: filters.documentId }
  return filters.authorId === null
    ? { decision, all: true, ...scope }
    : { decision, authorId: filters.authorId, ...scope }
}

function plural(count: number, singular: string, pluralForm: string): string {
  return `${String(count)} ${count > 1 ? pluralForm : singular}`
}

/** Bilan d'une décision pour le panneau (null : rien à signaler). */
export function decisionNotice(
  response: Pick<DecideSuggestionsResponse, 'results'>,
): string | null {
  const count = (outcome: string) =>
    response.results.filter((result) => result.outcome === outcome).length
  const parts = [
    count('accepted') > 0 ? plural(count('accepted'), 'acceptée', 'acceptées') : null,
    count('rejected') > 0 ? plural(count('rejected'), 'refusée', 'refusées') : null,
    count('stale') > 0
      ? `${plural(count('stale'), 'obsolète', 'obsolètes')} (texte d’origine modifié)`
      : null,
    count('unchanged') + count('missing') > 0
      ? plural(count('unchanged') + count('missing'), 'déjà traitée', 'déjà traitées')
      : null,
  ].filter((part): part is string => part !== null)
  if (parts.length === 0) return null
  return `Suggestions : ${parts.join(', ')}.`
}

/** Libellé court d'une suggestion. */
export const SUGGESTION_KIND_LABELS = {
  insert: 'Ajout',
  delete: 'Suppression',
  replace: 'Remplacement',
} as const

/**
 * Avertissement d'une suggestion du document actif : obsolète (décidée ou détectée dans le texte
 * courant), ou pas encore localisée.
 */
export function suggestionNotice(
  suggestion: Pick<Suggestion, 'status'>,
  resolution: SuggestionResolution | undefined,
): string | null {
  if (suggestion.status === 'stale' || resolution?.status === 'stale')
    return 'Obsolète : le texte d’origine a changé, la suggestion ne peut plus être appliquée.'
  if (resolution?.status === 'unknown') return 'Texte visé introuvable pour le moment'
  return null
}

const SUGGESTION_ERROR_MESSAGES: Record<string, string> = {
  [SUGGESTION_ERRORS.notFound]: 'Cette suggestion n’existe plus.',
  [SUGGESTION_ERRORS.notAuthor]: 'Seul l’auteur peut modifier ou retirer sa suggestion.',
  [SUGGESTION_ERRORS.alreadyDecided]:
    'Cette suggestion a déjà été acceptée ou refusée (ou est obsolète : retirez-la).',
  [SUGGESTION_ERRORS.documentNotFound]: 'Ce document n’existe plus.',
  [SUGGESTION_ERRORS.invalidAnchor]:
    'La position de la suggestion est illisible : recommencez la modification.',
  [SUGGESTION_ERRORS.rateLimited]:
    'Trop de suggestions ou de modifications : réessayez dans un instant.',
  [SUGGESTION_ERRORS.openLimit]:
    'Trop de suggestions en attente dans ce projet : faites accepter, refuser ou retirer les précédentes.',
  [SUGGESTION_ERRORS.realtimeUnavailable]:
    'Le service d’édition n’a pas confirmé l’opération : les suggestions concernées restent ouvertes, réessayez.',
}

/** Message français d'une erreur du suivi des modifications. */
export function suggestionErrorMessage(error: unknown): string {
  return localizedErrorMessage(error, SUGGESTION_ERROR_MESSAGES)
}
