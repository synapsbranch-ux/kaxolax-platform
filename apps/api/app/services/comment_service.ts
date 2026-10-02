import { anchorFromBase64, decodeCommentAnchor } from '@kaxolax/collab'
import {
  COMMENT_MAX_MENTIONS,
  COMMENT_MENTION_EMAIL_INTERVAL_MINUTES,
  COMMENT_RATE_LIMIT,
  type Comment as CommentEntry,
  type CommentAuthor,
  type CommentThread as CommentThreadEntry,
  type CommentThreadChange,
  type CommentThreadsQuery,
  type CreateCommentThreadInput,
  extractMentionIds,
  mentionToken,
} from '@kaxolax/contracts'
import { Exception } from '@adonisjs/core/exceptions'
import type { HttpContext } from '@adonisjs/core/http'
import db from '@adonisjs/lucid/services/db'
import type { TransactionClientContract } from '@adonisjs/lucid/types/database'
import { DateTime } from 'luxon'
import Comment from '#models/comment'
import CommentThread from '#models/comment_thread'
import Document from '#models/document'
import type Project from '#models/project'
import type User from '#models/user'
import { isUuid, projectFor } from '#services/project_access'

/**
 * Commentaires ancrés et panneau Review (contrats dans `packages/contracts/src/comments.ts`).
 * Lire : tout membre (`read`) ; écrire un fil ou une réponse, résoudre, rouvrir : permission
 * `comment` (owner, editor, reviewer, jamais viewer) ; modifier ou supprimer un message : son
 * auteur, s'il a encore la permission `comment`.
 *
 * L'ancre (positions relatives Yjs) est stockée telle quelle : l'API vérifie seulement qu'elle se
 * lit ; c'est le navigateur qui la résout dans le document Yjs courant.
 */

export class CommentThreadNotFoundException extends Exception {
  static override status = 404
  static override code = 'E_COMMENT_THREAD_NOT_FOUND'
  static override message = 'Comment thread not found'
}

export class CommentNotFoundException extends Exception {
  static override status = 404
  static override code = 'E_COMMENT_NOT_FOUND'
  static override message = 'Comment not found'
}

export class CommentNotAuthorException extends Exception {
  static override status = 403
  static override code = 'E_COMMENT_NOT_AUTHOR'
  static override message = 'Only the author can change this comment'
}

export class CommentDocumentNotFoundException extends Exception {
  static override status = 404
  static override code = 'E_DOCUMENT_NOT_FOUND'
  static override message = 'Document not found'
}

export class InvalidCommentAnchorException extends Exception {
  static override status = 422
  static override code = 'E_COMMENT_INVALID_ANCHOR'
  static override message = 'The comment anchor cannot be read'
}

export class CommentRateLimitedException extends Exception {
  static override status = 429
  static override code = 'E_COMMENT_RATE_LIMITED'
  static override message = 'Too many comments, try again later'

  constructor(readonly retryAfterSeconds: number) {
    super()
  }

  handle(_error: unknown, { response }: HttpContext) {
    response.header('retry-after', String(this.retryAfterSeconds))
    response.status(429).send({
      code: 'E_COMMENT_RATE_LIMITED',
      message: this.message,
      retryAfterSeconds: this.retryAfterSeconds,
    })
  }
}

// --- Lecture -------------------------------------------------------------------------------

interface AuthorRow {
  id: string
  full_name: string | null
  avatar_url: string | null
  deleted_at: Date | null
}

function serializeAuthor(row: AuthorRow | undefined, id: string): CommentAuthor {
  // Compte supprimé (anonymisé) ou introuvable : ni nom ni avatar.
  const visible = row?.deleted_at === null
  return {
    id,
    fullName: visible ? row.full_name : null,
    avatarUrl: visible ? row.avatar_url : null,
  }
}

function iso(value: DateTime | null): string | null {
  return value === null ? null : value.toJSDate().toISOString()
}

function serializeComment(comment: Comment, authors: Map<string, AuthorRow>): CommentEntry {
  return {
    id: comment.id,
    author: serializeAuthor(authors.get(comment.authorId), comment.authorId),
    body: comment.deletedAt === null ? comment.body : null,
    createdAt: comment.createdAt.toJSDate().toISOString(),
    editedAt: iso(comment.editedAt),
    deletedAt: iso(comment.deletedAt),
  }
}

/** Fils sérialisés avec leurs messages et auteurs (trois requêtes, quel que soit le nombre). */
async function serializeThreads(
  threads: CommentThread[],
  client?: TransactionClientContract,
): Promise<CommentThreadEntry[]> {
  if (threads.length === 0) return []
  const comments = await Comment.query({ client })
    .whereIn(
      'threadId',
      threads.map((thread) => thread.id),
    )
    .orderBy('createdAt', 'asc')
    .orderBy('id', 'asc')
  const authorIds = new Set<string>()
  for (const comment of comments) authorIds.add(comment.authorId)
  for (const thread of threads) if (thread.resolvedBy !== null) authorIds.add(thread.resolvedBy)
  const rows = (await (client ?? db)
    .from('users')
    .whereIn('id', [...authorIds])
    .select('id', 'full_name', 'avatar_url', 'deleted_at')) as AuthorRow[]
  const authors = new Map(rows.map((row) => [row.id, row]))

  const byThread = new Map<string, Comment[]>()
  for (const comment of comments) {
    const list = byThread.get(comment.threadId) ?? []
    list.push(comment)
    byThread.set(comment.threadId, list)
  }
  return threads.map((thread) => ({
    id: thread.id,
    documentId: thread.documentId,
    anchor: Buffer.from(thread.anchor).toString('base64'),
    quotedText: thread.quotedText,
    createdAt: thread.createdAt.toJSDate().toISOString(),
    resolvedAt: iso(thread.resolvedAt),
    resolvedBy:
      thread.resolvedBy === null
        ? null
        : serializeAuthor(authors.get(thread.resolvedBy), thread.resolvedBy),
    comments: (byThread.get(thread.id) ?? []).map((comment) => serializeComment(comment, authors)),
  }))
}

async function serializeThread(
  thread: CommentThread,
  client?: TransactionClientContract,
): Promise<CommentThreadEntry> {
  const [entry] = await serializeThreads([thread], client)
  if (!entry) throw new CommentThreadNotFoundException()
  return entry
}

/** Fils d'un projet (ou d'un document), du plus ancien au plus récent (tout membre). */
export async function listCommentThreads(
  user: User,
  projectId: string,
  query: CommentThreadsQuery,
): Promise<CommentThreadEntry[]> {
  const { project } = await projectFor(user, projectId, 'read')
  const threads = CommentThread.query().where('projectId', project.id)
  if (query.documentId !== undefined) void threads.where('documentId', query.documentId)
  if (query.status === 'open') void threads.whereNull('resolvedAt')
  if (query.status === 'resolved') void threads.whereNotNull('resolvedAt')
  return serializeThreads(await threads.orderBy('createdAt', 'asc').orderBy('id', 'asc'))
}

/** Un fil du projet, ou 404. */
async function threadOf(
  projectId: string,
  threadId: string,
  trx?: TransactionClientContract,
  lock = false,
): Promise<CommentThread> {
  if (!isUuid(threadId)) throw new CommentThreadNotFoundException()
  const query = CommentThread.query({ client: trx }).where({ projectId, id: threadId })
  if (lock) void query.forUpdate()
  const thread = await query.first()
  if (!thread) throw new CommentThreadNotFoundException()
  return thread
}

export async function showCommentThread(
  user: User,
  projectId: string,
  threadId: string,
): Promise<CommentThreadEntry> {
  const { project } = await projectFor(user, projectId, 'read')
  return serializeThread(await threadOf(project.id, threadId))
}

// --- Écriture ------------------------------------------------------------------------------

/**
 * Limite de débit d'un membre dans un projet (fils et réponses) sur une fenêtre glissante, sous
 * verrou consultatif : deux requêtes simultanées ne la dépassent pas.
 */
async function enforceRateLimit(
  trx: TransactionClientContract,
  projectId: string,
  userId: string,
  now: DateTime,
): Promise<void> {
  await trx.rawQuery('SELECT pg_advisory_xact_lock(hashtextextended(?, 0))', [
    `comments:${projectId}:${userId}`,
  ])
  const windowStart = now.minus({ seconds: COMMENT_RATE_LIMIT.windowSeconds })
  const recent = (await trx
    .from('comments as c')
    .join('comment_threads as t', 't.id', 'c.thread_id')
    .where('t.project_id', projectId)
    .where('c.author_id', userId)
    .where('c.created_at', '>', windowStart.toJSDate())
    .orderBy('c.created_at', 'desc')
    .limit(COMMENT_RATE_LIMIT.comments)
    .select('c.created_at')) as { created_at: Date }[]
  if (recent.length < COMMENT_RATE_LIMIT.comments) return
  // Le plus ancien message de la fenêtre en sort à cette date.
  const oldest = recent.at(-1)?.created_at.getTime() ?? now.toMillis()
  const wait = oldest + COMMENT_RATE_LIMIT.windowSeconds * 1000 - now.toMillis()
  throw new CommentRateLimitedException(Math.max(1, Math.ceil(wait / 1000)))
}

/** Membre mentionné à prévenir par email. */
export interface CommentMentionNotice {
  userId: string
  email: string
}

/** Message écrit (nouveau fil ou réponse), avec les emails de mention à envoyer. */
export interface PostedComment {
  project: Project
  thread: CommentThreadEntry
  comment: CommentEntry
  /** Membres mentionnés à prévenir (au plus un email par intervalle, voir `mentionsToNotify`). */
  notify: CommentMentionNotice[]
  /** Noms des membres mentionnés (texte de l'email). */
  names: Map<string, string | null>
}

/**
 * Membres mentionnés à prévenir : membres actifs du projet (tout rôle), autres que l'auteur, à
 * qui aucun email de mention de commentaire n'est parti pendant l'intervalle
 * (`COMMENT_MENTION_EMAIL_INTERVAL_MINUTES`) : au plus un email par intervalle et par projet, et
 * la mention suivante après l'intervalle en redonne un. La date d'envoi est réservée par une mise
 * à jour conditionnelle (`project_members.comment_mention_emailed_at`) : deux commentaires
 * simultanés ne donnent qu'un email.
 */
async function mentionsToNotify(
  trx: TransactionClientContract,
  projectId: string,
  comment: Comment,
): Promise<{ notify: CommentMentionNotice[]; names: Map<string, string | null> }> {
  const mentioned = extractMentionIds(comment.body)
    .filter((id) => id !== comment.authorId)
    .slice(0, COMMENT_MAX_MENTIONS)
  if (mentioned.length === 0) return { notify: [], names: new Map() }
  const since = comment.createdAt.minus({ minutes: COMMENT_MENTION_EMAIL_INTERVAL_MINUTES })
  const members = (await trx
    .from('project_members as pm')
    .join('users as u', 'u.id', 'pm.user_id')
    .where('pm.project_id', projectId)
    .whereIn('pm.user_id', mentioned)
    .whereNull('u.deleted_at')
    .whereNull('u.banned_at')
    .select('u.id', 'u.email', 'u.full_name')) as {
    id: string
    email: string
    full_name: string | null
  }[]
  const reachable = members.filter((member) => member.email !== '')
  const claimed =
    reachable.length === 0
      ? new Set<string>()
      : new Set(
          (
            (await trx
              .from('project_members')
              .where('project_id', projectId)
              .whereIn(
                'user_id',
                reachable.map((member) => member.id),
              )
              .where((query) => {
                void query
                  .whereNull('comment_mention_emailed_at')
                  .orWhere('comment_mention_emailed_at', '<=', since.toJSDate())
              })
              .update({ comment_mention_emailed_at: comment.createdAt.toJSDate() })
              .returning('user_id')) as { user_id: string }[]
          ).map((row) => row.user_id),
        )
  return {
    notify: reachable
      .filter((member) => claimed.has(member.id))
      .map((member) => ({ userId: member.id, email: member.email })),
    names: new Map(members.map((member) => [member.id, member.full_name])),
  }
}

/** Écrit un message dans un fil (verrouillé par l'appelant) et prépare les notifications. */
async function addComment(
  trx: TransactionClientContract,
  project: Project,
  thread: CommentThread,
  user: User,
  body: string,
  now: DateTime,
): Promise<PostedComment> {
  // Les mentions sont stockées en minuscules (format de `mentionToken`).
  const normalized = body.replaceAll(/<@([0-9a-f-]{36})>/gi, (_token, id: string) =>
    mentionToken(id),
  )
  const comment = await Comment.create(
    {
      threadId: thread.id,
      authorId: user.id,
      body: normalized,
      editedAt: null,
      deletedAt: null,
      createdAt: now,
    },
    { client: trx },
  )
  const { notify, names } = await mentionsToNotify(trx, project.id, comment)
  const entry = await serializeThread(thread, trx)
  const created = entry.comments.find((candidate) => candidate.id === comment.id)
  if (!created) throw new CommentNotFoundException()
  return { project, thread: entry, comment: created, notify, names }
}

/** Ouvre un fil sur une plage de texte d'un document (permission `comment`). */
export async function createCommentThread(
  user: User,
  projectId: string,
  input: CreateCommentThreadInput,
): Promise<PostedComment> {
  const anchor = anchorFromBase64(input.anchor)
  if (anchor === null || decodeCommentAnchor(anchor) === null) {
    throw new InvalidCommentAnchorException()
  }
  return db.transaction(async (trx) => {
    const { project } = await projectFor(user, projectId, 'comment', { trx })
    const document = await Document.query({ client: trx })
      .where({ projectId: project.id, id: input.documentId })
      .first()
    if (!document) throw new CommentDocumentNotFoundException()
    const now = DateTime.now()
    await enforceRateLimit(trx, project.id, user.id, now)
    const thread = await CommentThread.create(
      {
        projectId: project.id,
        documentId: document.id,
        anchor: Buffer.from(anchor),
        quotedText: input.quotedText,
        resolvedAt: null,
        resolvedBy: null,
        createdAt: now,
      },
      { client: trx },
    )
    return addComment(trx, project, thread, user, input.body, now)
  })
}

/** Répond dans un fil, résolu ou non (permission `comment`). */
export async function replyToThread(
  user: User,
  projectId: string,
  threadId: string,
  body: string,
): Promise<PostedComment> {
  return db.transaction(async (trx) => {
    const { project } = await projectFor(user, projectId, 'comment', { trx })
    const thread = await threadOf(project.id, threadId, trx, true)
    const now = DateTime.now()
    await enforceRateLimit(trx, project.id, user.id, now)
    return addComment(trx, project, thread, user, body, now)
  })
}

/** Changement d'un fil à annoncer sur le document meta. */
export interface ThreadChange {
  project: Project
  threadId: string
  documentId: string
  change: CommentThreadChange
  /** Fil à jour ; null s'il a été supprimé. */
  thread: CommentThreadEntry | null
}

/** Message de l'auteur dans le fil, non supprimé (404 sinon, 403 pour un autre auteur). */
async function ownComment(
  trx: TransactionClientContract,
  thread: CommentThread,
  commentId: string,
  user: User,
): Promise<Comment> {
  if (!isUuid(commentId)) throw new CommentNotFoundException()
  const comment = await Comment.query({ client: trx })
    .where({ threadId: thread.id, id: commentId })
    .whereNull('deletedAt')
    .forUpdate()
    .first()
  if (!comment) throw new CommentNotFoundException()
  if (comment.authorId !== user.id) throw new CommentNotAuthorException()
  return comment
}

/** Modifie son propre message (permission `comment`). Les mentions ajoutées ne notifient pas. */
export async function editComment(
  user: User,
  projectId: string,
  threadId: string,
  commentId: string,
  body: string,
): Promise<ThreadChange> {
  return db.transaction(async (trx) => {
    const { project } = await projectFor(user, projectId, 'comment', { trx })
    const thread = await threadOf(project.id, threadId, trx, true)
    const comment = await ownComment(trx, thread, commentId, user)
    comment.body = body.replaceAll(/<@([0-9a-f-]{36})>/gi, (_token, id: string) => mentionToken(id))
    comment.editedAt = DateTime.now()
    await comment.useTransaction(trx).save()
    return {
      project,
      threadId: thread.id,
      documentId: thread.documentId,
      change: 'comment-edited',
      thread: await serializeThread(thread, trx),
    }
  })
}

/**
 * Supprime son propre message (permission `comment`) : le texte est effacé, sa place reste dans
 * le fil (« message supprimé »). Quand plus aucun message n'est visible, le fil est supprimé.
 */
export async function deleteComment(
  user: User,
  projectId: string,
  threadId: string,
  commentId: string,
): Promise<ThreadChange> {
  return db.transaction(async (trx) => {
    const { project } = await projectFor(user, projectId, 'comment', { trx })
    const thread = await threadOf(project.id, threadId, trx, true)
    const comment = await ownComment(trx, thread, commentId, user)
    comment.body = ''
    comment.deletedAt = DateTime.now()
    await comment.useTransaction(trx).save()

    const remaining = await Comment.query({ client: trx })
      .where('threadId', thread.id)
      .whereNull('deletedAt')
      .first()
    if (remaining === null) {
      await thread.useTransaction(trx).delete()
      return {
        project,
        threadId: thread.id,
        documentId: thread.documentId,
        change: 'deleted',
        thread: null,
      }
    }
    return {
      project,
      threadId: thread.id,
      documentId: thread.documentId,
      change: 'comment-deleted',
      thread: await serializeThread(thread, trx),
    }
  })
}

/**
 * Résout (`resolved` vrai) ou rouvre un fil (permission `comment`). Idempotent : résoudre un fil
 * déjà résolu le laisse tel quel (`changed` faux, rien à annoncer).
 */
export async function setThreadResolved(
  user: User,
  projectId: string,
  threadId: string,
  resolved: boolean,
): Promise<ThreadChange & { changed: boolean }> {
  return db.transaction(async (trx) => {
    const { project } = await projectFor(user, projectId, 'comment', { trx })
    const thread = await threadOf(project.id, threadId, trx, true)
    const changed = resolved === (thread.resolvedAt === null)
    if (changed) {
      thread.resolvedAt = resolved ? DateTime.now() : null
      thread.resolvedBy = resolved ? user.id : null
      await thread.useTransaction(trx).save()
    }
    return {
      project,
      threadId: thread.id,
      documentId: thread.documentId,
      change: resolved ? 'resolved' : 'reopened',
      thread: await serializeThread(thread, trx),
      changed,
    }
  })
}

/** Longueur maximale de l'extrait d'un commentaire et de la citation dans l'email de mention. */
const EXCERPT_MAX_LENGTH = 500

/** Texte borné pour un email (`…` final si tronqué). */
export function excerpt(text: string): string {
  return text.length > EXCERPT_MAX_LENGTH ? `${text.slice(0, EXCERPT_MAX_LENGTH - 1)}…` : text
}
