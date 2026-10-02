import {
  commentBodyInputSchema,
  type CommentThreadResponse,
  type CommentThreadsResponse,
  commentThreadsQuerySchema,
  createCommentThreadInputSchema,
} from '@kaxolax/contracts'
import { inject } from '@adonisjs/core'
import type { HttpContext } from '@adonisjs/core/http'
import logger from '@adonisjs/core/services/logger'
import mail from '@adonisjs/mail/services/main'
import { appUrl } from '#config/app'
import CommentMentionMail from '#mails/comment_mention_mail'
import Document from '#models/document'
import { mentionExcerpt } from '#services/chat_service'
import {
  createCommentThread,
  deleteComment,
  editComment,
  excerpt,
  listCommentThreads,
  type PostedComment,
  replyToThread,
  setThreadResolved,
  showCommentThread,
  type ThreadChange,
} from '#services/comment_service'
import RealtimeClient from '#services/realtime_client'
import { validateWithZod } from '#validators/zod'

/**
 * Commentaires ancrés et panneau Review (contrats dans `packages/contracts/src/comments.ts`).
 * Chaque écriture est annoncée sur le document meta du projet une fois la transaction validée :
 * `comment.created` (nouveau fil, réponse) ou `comment.thread-updated` (modification, suppression,
 * résolution, réouverture).
 */
@inject()
export default class CommentsController {
  constructor(private readonly realtime: RealtimeClient) {}

  async index({ params, request, auth }: HttpContext): Promise<CommentThreadsResponse> {
    const query = validateWithZod(commentThreadsQuerySchema, request.qs())
    return { threads: await listCommentThreads(auth.getUserOrFail(), String(params.id), query) }
  }

  async show({ params, auth }: HttpContext): Promise<CommentThreadResponse> {
    return {
      thread: await showCommentThread(
        auth.getUserOrFail(),
        String(params.id),
        String(params.threadId),
      ),
    }
  }

  async store({ params, request, auth, response }: HttpContext) {
    const input = validateWithZod(createCommentThreadInputSchema, request.body())
    const posted = await createCommentThread(auth.getUserOrFail(), String(params.id), input)
    await this.announceComment(posted)
    const result: CommentThreadResponse = { thread: posted.thread }
    response.status(201).send(result)
  }

  async reply({ params, request, auth, response }: HttpContext) {
    const { body } = validateWithZod(commentBodyInputSchema, request.body())
    const posted = await replyToThread(
      auth.getUserOrFail(),
      String(params.id),
      String(params.threadId),
      body,
    )
    await this.announceComment(posted)
    const result: CommentThreadResponse = { thread: posted.thread }
    response.status(201).send(result)
  }

  async update({ params, request, auth }: HttpContext): Promise<CommentThreadResponse> {
    const { body } = validateWithZod(commentBodyInputSchema, request.body())
    const user = auth.getUserOrFail()
    const change = await editComment(
      user,
      String(params.id),
      String(params.threadId),
      String(params.commentId),
      body,
    )
    await this.announceChange(change, user.id)
    return { thread: change.thread }
  }

  async destroy({ params, auth }: HttpContext): Promise<CommentThreadResponse> {
    const user = auth.getUserOrFail()
    const change = await deleteComment(
      user,
      String(params.id),
      String(params.threadId),
      String(params.commentId),
    )
    await this.announceChange(change, user.id)
    return { thread: change.thread }
  }

  async resolve(ctx: HttpContext): Promise<CommentThreadResponse> {
    return this.setResolved(ctx, true)
  }

  async reopen(ctx: HttpContext): Promise<CommentThreadResponse> {
    return this.setResolved(ctx, false)
  }

  private async setResolved(
    { params, auth }: HttpContext,
    resolved: boolean,
  ): Promise<CommentThreadResponse> {
    const user = auth.getUserOrFail()
    const change = await setThreadResolved(
      user,
      String(params.id),
      String(params.threadId),
      resolved,
    )
    if (change.changed) await this.announceChange(change, user.id)
    return { thread: change.thread }
  }

  private async announceChange(change: ThreadChange, actorId: string): Promise<void> {
    await this.realtime.publishProjectEvent(change.project.id, {
      type: 'comment.thread-updated',
      threadId: change.threadId,
      documentId: change.documentId,
      change: change.change,
      actorId,
    })
  }

  /** Annonce le nouveau message, puis envoie les emails de mention (au mieux). */
  private async announceComment(posted: PostedComment): Promise<void> {
    await this.realtime.publishProjectEvent(posted.project.id, {
      type: 'comment.created',
      threadId: posted.thread.id,
      commentId: posted.comment.id,
      documentId: posted.thread.documentId,
      authorId: posted.comment.author.id,
    })
    if (posted.notify.length === 0) return
    const document = await Document.find(posted.thread.documentId)
    const url = `${appUrl.replace(/\/$/, '')}/project/${posted.project.id}?comment=${posted.thread.id}`
    const text = mentionExcerpt(posted.comment.body ?? '', posted.names)
    for (const recipient of posted.notify) {
      try {
        await mail.send(
          new CommentMentionMail({
            to: recipient.email,
            projectName: posted.project.name,
            documentName: document?.name ?? 'un document',
            authorName: posted.comment.author.fullName,
            quotedText: excerpt(posted.thread.quotedText),
            excerpt: text,
            url,
          }),
        )
      } catch (error) {
        logger.error(
          { err: error, commentId: posted.comment.id, userId: recipient.userId },
          'comment mention email failed',
        )
      }
    }
  }
}
