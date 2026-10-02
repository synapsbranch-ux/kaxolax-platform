import { z } from 'zod'
import { chatAuthorSchema } from './chat.js'

/**
 * Commentaires ancrés dans le texte et panneau Review : contrats des routes
 * `/api/v1/projects/:id/comment-threads/*`. Dates ISO 8601 en UTC.
 *
 * Un fil est ancré dans un document par deux positions relatives Yjs (début et fin, voir
 * `@kaxolax/collab`, anchors) transmises en base64, et garde la citation d'origine, affichée si
 * le texte ancré disparaît. Lire : tout membre ; commenter, répondre, résoudre, rouvrir : permission
 * `comment` (owner, editor, reviewer) ; modifier ou supprimer un message : son auteur seulement.
 * Les mentions suivent le format du chat (`<@uuid>`, `extractMentionIds`).
 */

const isoDate = z.iso.datetime()

/** Longueur maximale d'un message, après suppression des espaces aux extrémités. */
export const COMMENT_BODY_MAX_LENGTH = 4000
/** Longueur maximale de la citation d'origine (l'interface tronque une sélection plus longue). */
export const COMMENT_QUOTE_MAX_LENGTH = 1000
/** Longueur maximale d'une ancre en base64 (`MAX_ANCHOR_BYTES` de `@kaxolax/collab`). */
export const COMMENT_ANCHOR_MAX_LENGTH = 700
/** Messages (fils et réponses) qu'un membre peut écrire dans un projet par fenêtre glissante. */
export const COMMENT_RATE_LIMIT = { comments: 30, windowSeconds: 60 } as const
/**
 * Emails de mention : une personne mentionnée reçoit au plus un email par intervalle et par projet
 * (les mentions suivantes de l'intervalle sont visibles dans le panneau Review).
 */
export const COMMENT_MENTION_EMAIL_INTERVAL_MINUTES = 10
/** Mentions distinctes prises en compte par message. */
export const COMMENT_MAX_MENTIONS = 20

/** Codes d'erreur propres aux commentaires (`code` du corps de la réponse). */
export const COMMENT_ERRORS = {
  /** 404 : fil inconnu dans ce projet. */
  threadNotFound: 'E_COMMENT_THREAD_NOT_FOUND',
  /** 404 : message inconnu dans ce fil, ou déjà supprimé. */
  commentNotFound: 'E_COMMENT_NOT_FOUND',
  /** 403 : seul l'auteur modifie ou supprime son message. */
  notAuthor: 'E_COMMENT_NOT_AUTHOR',
  /** 404 : le document visé n'existe pas dans ce projet. */
  documentNotFound: 'E_DOCUMENT_NOT_FOUND',
  /** 422 : ancre illisible (positions relatives Yjs mal encodées). */
  invalidAnchor: 'E_COMMENT_INVALID_ANCHOR',
  /** 429 : trop de messages sur la fenêtre (`retryAfterSeconds`). */
  rateLimited: 'E_COMMENT_RATE_LIMITED',
} as const

const bodySchema = z
  .string()
  .trim()
  .min(1, 'The comment is empty')
  .max(
    COMMENT_BODY_MAX_LENGTH,
    `The comment is longer than ${String(COMMENT_BODY_MAX_LENGTH)} characters`,
  )

/** Auteur d'un message ou d'une résolution (jamais son email). */
export const commentAuthorSchema = chatAuthorSchema
export type CommentAuthor = z.infer<typeof commentAuthorSchema>

export const commentSchema = z.object({
  id: z.uuid(),
  author: commentAuthorSchema,
  /** Texte brut, mentions `<@uuid>` ; null pour un message supprimé (sa place reste dans le fil). */
  body: z.string().nullable(),
  createdAt: isoDate,
  editedAt: isoDate.nullable(),
  deletedAt: isoDate.nullable(),
})
export type Comment = z.infer<typeof commentSchema>

export const commentThreadSchema = z.object({
  id: z.uuid(),
  documentId: z.uuid(),
  /** Positions relatives Yjs (début et fin) encodées, en base64. */
  anchor: z.string().min(1).max(COMMENT_ANCHOR_MAX_LENGTH),
  /** Citation d'origine du texte commenté. */
  quotedText: z.string(),
  createdAt: isoDate,
  resolvedAt: isoDate.nullable(),
  resolvedBy: commentAuthorSchema.nullable(),
  /** Du plus ancien au plus récent ; le premier ouvre le fil. */
  comments: z.array(commentSchema),
})
export type CommentThread = z.infer<typeof commentThreadSchema>

export const commentThreadStatusSchema = z.enum(['open', 'resolved', 'all'])
export type CommentThreadStatus = z.infer<typeof commentThreadStatusSchema>

/** `GET /projects/:id/comment-threads` (tout membre) : fils du projet, ou d'un document. */
export const commentThreadsQuerySchema = z.object({
  documentId: z.uuid().optional(),
  status: commentThreadStatusSchema.default('all'),
})
export type CommentThreadsQuery = z.infer<typeof commentThreadsQuerySchema>

export const commentThreadsResponseSchema = z.object({
  /** Du plus ancien au plus récent. */
  threads: z.array(commentThreadSchema),
})
export type CommentThreadsResponse = z.infer<typeof commentThreadsResponseSchema>

/** `POST /projects/:id/comment-threads` (permission `comment`). Réponse 201 : le fil. */
export const createCommentThreadInputSchema = z.object({
  documentId: z.uuid(),
  anchor: z
    .string()
    .min(1)
    .max(COMMENT_ANCHOR_MAX_LENGTH)
    .regex(/^[A-Za-z0-9+/]+={0,2}$/, 'The anchor must be base64'),
  quotedText: z
    .string()
    .min(1, 'The quoted text is empty')
    .max(
      COMMENT_QUOTE_MAX_LENGTH,
      `The quoted text is longer than ${String(COMMENT_QUOTE_MAX_LENGTH)} characters`,
    ),
  body: bodySchema,
})
export type CreateCommentThreadInput = z.infer<typeof createCommentThreadInputSchema>

/**
 * `POST /projects/:id/comment-threads/:threadId/comments` (réponse, permission `comment`) et
 * `PATCH …/comments/:commentId` (modification par l'auteur). Réponse : le fil à jour.
 */
export const commentBodyInputSchema = z.object({ body: bodySchema })
export type CommentBodyInput = z.infer<typeof commentBodyInputSchema>

/**
 * Réponse des routes d'un fil : `GET …/:threadId`, réponse, modification, résolution
 * (`POST …/resolve`), réouverture (`POST …/reopen`) et suppression d'un message
 * (`DELETE …/comments/:commentId`, null si c'était le dernier message visible : le fil disparaît).
 */
export const commentThreadResponseSchema = z.object({ thread: commentThreadSchema.nullable() })
export type CommentThreadResponse = z.infer<typeof commentThreadResponseSchema>

/** 429 de l'écriture d'un message. */
export const commentRateLimitedErrorSchema = z.object({
  code: z.literal('E_COMMENT_RATE_LIMITED'),
  message: z.string(),
  retryAfterSeconds: z.number().int().positive(),
})

// --- Événements (document meta, voir events.ts) ---------------------------------------------

// Nouveau fil ou réponse : `comment.created`, défini dans events.ts.

export const commentThreadChangeSchema = z.enum([
  'comment-edited',
  'comment-deleted',
  'resolved',
  'reopened',
  /** Dernier message visible supprimé : le fil n'existe plus. */
  'deleted',
])
export type CommentThreadChange = z.infer<typeof commentThreadChangeSchema>

/** Un fil a changé (modification, suppression, résolution, réouverture) : le client le relit. */
export const commentThreadUpdatedEventSchema = z.object({
  type: z.literal('comment.thread-updated'),
  threadId: z.uuid(),
  documentId: z.uuid(),
  change: commentThreadChangeSchema,
  actorId: z.uuid(),
})
export type CommentThreadUpdatedEvent = z.infer<typeof commentThreadUpdatedEventSchema>
