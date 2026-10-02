import type { ResolvedAnchor } from '@kaxolax/collab'
import {
  COMMENT_ERRORS,
  COMMENT_QUOTE_MAX_LENGTH,
  type Comment,
  type CommentThread,
} from '@kaxolax/contracts'
import { localizedErrorMessage, type ProjectTree } from './api'
import type { ChatMember, PickedMention } from './chat'

/**
 * Logique du panneau Review, sans React : filtre ouverts / résolus, ordre des fils (document
 * actif d'abord, dans l'ordre du texte), navigation au suivant et au précédent, fusion des fils
 * relus, droits sur un message, citation d'une sélection.
 */

export type ReviewFilter = 'open' | 'resolved'

export function isResolved(thread: CommentThread): boolean {
  return thread.resolvedAt !== null
}

export function filterThreads(
  threads: readonly CommentThread[],
  filter: ReviewFilter,
): CommentThread[] {
  return threads.filter((thread) => isResolved(thread) === (filter === 'resolved'))
}

/** Nombre de fils ouverts et résolus (onglets du panneau). */
export function threadCounts(threads: readonly CommentThread[]): Record<ReviewFilter, number> {
  const resolved = threads.filter(isResolved).length
  return { open: threads.length - resolved, resolved }
}

/** Position d'un fil dans le texte du document actif (null : inconnue, en fin de liste). */
function textPosition(position: ResolvedAnchor | undefined): number | null {
  if (position === undefined) return null
  if (position.status === 'attached') return position.from
  if (position.status === 'detached') return position.at
  return null
}

/**
 * Ordre d'affichage et de navigation : les fils du document actif dans l'ordre du texte (positions
 * résolues dans l'éditeur ; inconnues ensuite, par date), puis ceux des autres documents par
 * chemin, puis par date.
 */
export function orderThreads(
  threads: readonly CommentThread[],
  options: {
    tree: ProjectTree | null
    activeDocumentId: string | null
    positions: ReadonlyMap<string, ResolvedAnchor>
  },
): CommentThread[] {
  const pathOf = (documentId: string) =>
    options.tree?.documents.find((document) => document.id === documentId)?.path ?? '￿'
  const key = (thread: CommentThread) => {
    const active = thread.documentId === options.activeDocumentId
    const position = active ? textPosition(options.positions.get(thread.id)) : null
    return { active, position, path: pathOf(thread.documentId) }
  }
  return [...threads].sort((a, b) => {
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

/**
 * Fil suivant (`1`) ou précédent (`-1`) dans la liste ordonnée, en boucle ; le premier (ou le
 * dernier) si aucun fil n'est sélectionné ou s'il n'est plus dans la liste. Null si la liste est vide.
 */
export function adjacentThread(
  ordered: readonly CommentThread[],
  currentId: string | null,
  direction: 1 | -1,
): string | null {
  if (ordered.length === 0) return null
  const index = ordered.findIndex((thread) => thread.id === currentId)
  if (index < 0) return (direction === 1 ? ordered[0] : ordered.at(-1))?.id ?? null
  return ordered[(index + direction + ordered.length) % ordered.length]?.id ?? null
}

/** Remplace (ou ajoute) un fil relu ; null le retire (fil supprimé). */
export function upsertThread(
  threads: readonly CommentThread[],
  threadId: string,
  thread: CommentThread | null,
): CommentThread[] {
  const others = threads.filter((candidate) => candidate.id !== threadId)
  if (thread === null) return others
  const index = threads.findIndex((candidate) => candidate.id === threadId)
  if (index < 0) return [...others, thread]
  return threads.map((candidate) => (candidate.id === threadId ? thread : candidate))
}

/** Vrai si l'utilisateur peut modifier ou supprimer ce message (le sien, rôle qui commente). */
export function canChangeComment(
  comment: Comment,
  selfId: string | null,
  canComment: boolean,
): boolean {
  return canComment && comment.deletedAt === null && comment.author.id === selfId
}

/** Citation d'origine d'une sélection, bornée (`…` final si tronquée). */
export function quoteOf(text: string): string {
  if (text.length <= COMMENT_QUOTE_MAX_LENGTH) return text
  return `${text.slice(0, COMMENT_QUOTE_MAX_LENGTH - 1)}…`
}

/**
 * Libellé d'état du texte ancré, null quand il est en place : supprimé (citation d'origine
 * affichée), ou pas encore localisé dans le document ouvert.
 */
export function anchorNotice(position: ResolvedAnchor | undefined): string | null {
  if (position?.status === 'detached') return 'Texte commenté supprimé'
  if (position?.status === 'unknown') return 'Texte commenté introuvable pour le moment'
  return null
}

/** Fil à ouvrir depuis l'URL (`?comment=<id>`, lien de l'email de mention), ou null. */
export function threadFromSearch(search: string): string | null {
  const id = new URLSearchParams(search).get('comment')
  return id !== null && /^[0-9a-f-]{36}$/i.test(id) ? id.toLowerCase() : null
}

/**
 * Texte modifiable d'un message enregistré : chaque `<@uuid>` d'un membre connu redevient `@Nom`
 * (et compte comme mention choisie, réencodée à l'envoi) ; un ancien membre reste `<@uuid>`.
 */
export function mentionsToText(
  body: string,
  members: readonly ChatMember[],
): { text: string; picked: PickedMention[] } {
  const byId = new Map(members.map((member) => [member.id, member]))
  const picked: PickedMention[] = []
  const text = body.replace(/<@([0-9a-f-]{36})>/gi, (token, id: string) => {
    const member = byId.get(id.toLowerCase())
    if (!member) return token
    picked.push({ id: member.id, name: member.name })
    return `@${member.name}`
  })
  return { text, picked }
}

const COMMENT_ERROR_MESSAGES: Record<string, string> = {
  [COMMENT_ERRORS.threadNotFound]: 'Ce fil de commentaires n’existe plus.',
  [COMMENT_ERRORS.commentNotFound]: 'Ce message n’existe plus.',
  [COMMENT_ERRORS.notAuthor]: 'Seul l’auteur peut modifier ou supprimer ce message.',
  [COMMENT_ERRORS.documentNotFound]: 'Ce document n’existe plus.',
  [COMMENT_ERRORS.invalidAnchor]:
    'La position du commentaire est illisible : sélectionnez de nouveau le texte.',
  [COMMENT_ERRORS.rateLimited]: 'Trop de commentaires : réessayez dans un instant.',
}

/** Message français d'une erreur des commentaires (panneau Review). */
export function commentErrorMessage(error: unknown): string {
  return localizedErrorMessage(error, COMMENT_ERROR_MESSAGES)
}

/**
 * Fils dont le document est encore dans l'arborescence (ceux d'un document supprimé, ou retiré
 * par une restauration, sont supprimés avec lui côté serveur). Arborescence pas encore chargée :
 * tous les fils.
 */
export function threadsInTree<T extends Pick<CommentThread, 'documentId'>>(
  threads: readonly T[],
  tree: Pick<ProjectTree, 'documents'> | null,
): T[] {
  if (!tree) return [...threads]
  const ids = new Set(tree.documents.map((document) => document.id))
  return threads.filter((thread) => ids.has(thread.documentId))
}
