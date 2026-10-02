import { z } from 'zod'

/**
 * Chat du projet (onglet Chats) : contrats des routes `/api/v1/projects/:id/chat/*`, format des
 * mentions et des références de fichier dans le texte d'un message. Dates ISO 8601 en UTC.
 *
 * Un message est du texte brut, jamais du HTML : l'interface l'affiche segment par segment
 * (`parseChatBody`). Une mention d'un membre est stockée sous la forme `<@uuid>` ; le nom affiché
 * est relu dans la liste des membres, et suit donc un changement de nom.
 */

const isoDate = z.iso.datetime()

/** Longueur maximale d'un message, en caractères après suppression des espaces aux extrémités. */
export const CHAT_MESSAGE_MAX_LENGTH = 4000
/** Messages renvoyés par défaut, et au plus, par page de l'historique. */
export const CHAT_PAGE_SIZE = 50
export const CHAT_PAGE_MAX_SIZE = 100
/** Messages qu'un membre peut envoyer dans un projet sur une fenêtre glissante (429 au-delà). */
export const CHAT_RATE_LIMIT = { messages: 20, windowSeconds: 60 } as const
/** Mentions distinctes prises en compte par message (notifications). */
export const CHAT_MAX_MENTIONS = 20

/** Codes d'erreur propres au chat (`code` du corps de la réponse). */
export const CHAT_ERRORS = {
  /** 429 : trop de messages envoyés sur la fenêtre (`retryAfterSeconds`). */
  rateLimited: 'E_CHAT_RATE_LIMITED',
  /** 404 : message de référence (`before`, `after`, `upTo`) inconnu dans ce projet. */
  messageNotFound: 'E_CHAT_MESSAGE_NOT_FOUND',
} as const

// --- Mentions et références -----------------------------------------------------------------

const UUID_SOURCE = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'

/** Forme stockée d'une mention : `<@uuid>`. */
export function mentionToken(userId: string): string {
  return `<@${userId.toLowerCase()}>`
}

/** Identifiants mentionnés dans un message, sans doublon, dans l'ordre d'apparition. */
export function extractMentionIds(body: string): string[] {
  const ids = new Set<string>()
  for (const match of body.matchAll(new RegExp(`<@(${UUID_SOURCE})>`, 'gi'))) {
    const id = match[1]
    if (id !== undefined) ids.add(id.toLowerCase())
  }
  return [...ids]
}

/**
 * Segment d'un message : texte, mention d'un membre, ou référence `chemin:ligne` (un lien n'est
 * proposé que si le chemin désigne un fichier du projet, ce que l'interface vérifie).
 */
export type ChatSegment =
  | { kind: 'text'; text: string }
  | { kind: 'mention'; userId: string }
  | { kind: 'file-ref'; path: string; line: number; text: string }

/**
 * Mention, ou référence de fichier : un chemin relatif (dossiers séparés par `/`) dont le nom a
 * une extension, suivi de `:ligne`. Ni précédé d'un caractère de chemin (pas de coupure au milieu
 * d'un mot ou d'une URL), ni suivi d'un chiffre ou d'une lettre. Lettres accentuées admises.
 */
const PATH_CHAR = '[\\p{L}\\p{N}_.-]'
const SEGMENT_PATTERN = new RegExp(
  `<@(${UUID_SOURCE})>|(?<![\\p{L}\\p{N}_./:-])((?:${PATH_CHAR}+/)*[\\p{L}\\p{N}_-]${PATH_CHAR}*\\.[A-Za-z0-9]+):([1-9]\\d{0,6})(?![\\p{L}\\p{N}_])`,
  'giu',
)

/** Découpe le texte d'un message en segments (affichage sûr, sans interprétation de HTML). */
export function parseChatBody(body: string): ChatSegment[] {
  const segments: ChatSegment[] = []
  let last = 0
  const pushText = (text: string) => {
    if (text === '') return
    const previous = segments.at(-1)
    if (previous?.kind === 'text') previous.text += text
    else segments.push({ kind: 'text', text })
  }
  for (const match of body.matchAll(SEGMENT_PATTERN)) {
    const [whole, userId, path, line] = match
    pushText(body.slice(last, match.index))
    if (userId !== undefined) segments.push({ kind: 'mention', userId: userId.toLowerCase() })
    else if (path !== undefined && line !== undefined)
      segments.push({ kind: 'file-ref', path, line: Number(line), text: whole })
    else pushText(whole)
    last = match.index + whole.length
  }
  pushText(body.slice(last))
  return segments
}

// --- Messages -------------------------------------------------------------------------------

/** Auteur d'un message (jamais son email : le chat est visible de tous les membres). */
export const chatAuthorSchema = z.object({
  id: z.uuid(),
  /** Null pour un compte sans nom ou supprimé (anonymisé). */
  fullName: z.string().nullable(),
  avatarUrl: z.string().nullable(),
})
export type ChatAuthor = z.infer<typeof chatAuthorSchema>

export const chatMessageSchema = z.object({
  id: z.uuid(),
  author: chatAuthorSchema,
  /** Texte brut, mentions sous la forme `<@uuid>`. */
  body: z.string(),
  createdAt: isoDate,
})
export type ChatMessage = z.infer<typeof chatMessageSchema>

/** `POST /projects/:id/chat/messages` (tout membre). Réponse 201 : `chatMessageResponseSchema`. */
export const createChatMessageInputSchema = z.object({
  body: z
    .string()
    .trim()
    .min(1, 'The message is empty')
    .max(
      CHAT_MESSAGE_MAX_LENGTH,
      `The message is longer than ${String(CHAT_MESSAGE_MAX_LENGTH)} characters`,
    ),
})
export type CreateChatMessageInput = z.infer<typeof createChatMessageInputSchema>

export const chatMessageResponseSchema = z.object({ message: chatMessageSchema })
export type ChatMessageResponse = z.infer<typeof chatMessageResponseSchema>

/** Non-lus d'un membre : messages des autres postérieurs à sa dernière lecture. */
export const chatUnreadSchema = z.object({
  count: z.number().int().nonnegative(),
  /** Dernière lecture ; null s'il n'a jamais ouvert le chat (compte depuis son arrivée). */
  lastReadAt: isoDate.nullable(),
})
export type ChatUnread = z.infer<typeof chatUnreadSchema>

/**
 * `GET /projects/:id/chat/messages` (tout membre). Sans curseur : les messages les plus récents.
 * `before` : les messages antérieurs à ce message (défilement vers le haut) ; `after` : ceux qui
 * le suivent (rattrapage après un événement ou une reconnexion). Un seul des deux.
 */
export const chatMessagesQuerySchema = z
  .object({
    before: z.uuid().optional(),
    after: z.uuid().optional(),
    limit: z.coerce.number().int().min(1).max(CHAT_PAGE_MAX_SIZE).default(CHAT_PAGE_SIZE),
  })
  .refine((query) => query.before === undefined || query.after === undefined, {
    message: 'Use either before or after, not both',
    path: ['after'],
  })
export type ChatMessagesQuery = z.infer<typeof chatMessagesQuerySchema>

export const chatMessagesResponseSchema = z.object({
  /** Du plus ancien au plus récent. */
  messages: z.array(chatMessageSchema),
  /**
   * D'autres messages existent au-delà de la page : plus anciens (sans curseur ou avec `before`),
   * ou plus récents (avec `after`).
   */
  hasMore: z.boolean(),
  unread: chatUnreadSchema,
})
export type ChatMessagesResponse = z.infer<typeof chatMessagesResponseSchema>

/**
 * `POST /projects/:id/chat/read` (tout membre) : marque comme lu jusqu'au message `upTo` (inclus),
 * ou jusqu'à maintenant sans `upTo`. La dernière lecture ne recule jamais. Réponse : les non-lus.
 */
export const markChatReadInputSchema = z.object({ upTo: z.uuid().optional() })
export type MarkChatReadInput = z.infer<typeof markChatReadInputSchema>

export const chatUnreadResponseSchema = z.object({ unread: chatUnreadSchema })
export type ChatUnreadResponse = z.infer<typeof chatUnreadResponseSchema>

/** 429 de l'envoi d'un message. */
export const chatRateLimitedErrorSchema = z.object({
  code: z.literal('E_CHAT_RATE_LIMITED'),
  message: z.string(),
  retryAfterSeconds: z.number().int().positive(),
})
export type ChatRateLimitedError = z.infer<typeof chatRateLimitedErrorSchema>
