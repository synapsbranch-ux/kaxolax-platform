import {
  type ChatMessageResponse,
  type ChatMessagesResponse,
  chatMessagesQuerySchema,
  type ChatUnreadResponse,
  createChatMessageInputSchema,
  markChatReadInputSchema,
} from '@kaxolax/contracts'
import { inject } from '@adonisjs/core'
import type { HttpContext } from '@adonisjs/core/http'
import logger from '@adonisjs/core/services/logger'
import mail from '@adonisjs/mail/services/main'
import { appUrl } from '#config/app'
import ChatMentionMail from '#mails/chat_mention_mail'
import {
  listChatMessages,
  markChatRead,
  mentionExcerpt,
  type PostedChatMessage,
  postChatMessage,
} from '#services/chat_service'
import RealtimeClient from '#services/realtime_client'
import { validateWithZod } from '#validators/zod'

/**
 * Chat du projet (contrats dans `packages/contracts/src/chat.ts`) : historique paginé, envoi,
 * dernière lecture. Un nouveau message est annoncé sur le document meta du projet
 * (`chat.message-created`) une fois la transaction validée.
 */
@inject()
export default class ChatController {
  constructor(private readonly realtime: RealtimeClient) {}

  async index({ params, request, auth }: HttpContext): Promise<ChatMessagesResponse> {
    const query = validateWithZod(chatMessagesQuerySchema, request.qs())
    return listChatMessages(auth.getUserOrFail(), String(params.id), query)
  }

  async store({ params, request, auth, response }: HttpContext) {
    const { body } = validateWithZod(createChatMessageInputSchema, request.body())
    const user = auth.getUserOrFail()
    const posted = await postChatMessage(user, String(params.id), body)
    await this.realtime.publishProjectEvent(posted.project.id, {
      type: 'chat.message-created',
      messageId: posted.message.id,
      authorId: user.id,
    })
    await this.notifyMentions(posted)
    const result: ChatMessageResponse = { message: posted.message }
    response.status(201).send(result)
  }

  async read({ params, request, auth }: HttpContext): Promise<ChatUnreadResponse> {
    const { upTo } = validateWithZod(markChatReadInputSchema, request.body())
    return { unread: await markChatRead(auth.getUserOrFail(), String(params.id), upTo) }
  }

  /** Emails de mention, au mieux : un échec est journalisé sans faire échouer l'envoi du message. */
  private async notifyMentions(posted: PostedChatMessage): Promise<void> {
    if (posted.notify.length === 0) return
    const excerpt = mentionExcerpt(posted.message.body, posted.names)
    const url = `${appUrl.replace(/\/$/, '')}/project/${posted.project.id}?panel=chat`
    for (const recipient of posted.notify) {
      try {
        await mail.send(
          new ChatMentionMail({
            to: recipient.email,
            projectName: posted.project.name,
            authorName: posted.message.author.fullName,
            excerpt,
            url,
          }),
        )
      } catch (error) {
        logger.error(
          { err: error, messageId: posted.message.id, userId: recipient.userId },
          'chat mention email failed',
        )
      }
    }
  }
}
