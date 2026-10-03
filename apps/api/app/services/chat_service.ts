import { randomUUID } from 'node:crypto'
import {
  CHAT_MAX_MENTIONS,
  CHAT_RATE_LIMIT,
  type ChatMessage as ChatMessageEntry,
  type ChatMessagesQuery,
  type ChatMessagesResponse,
  type ChatUnread,
  extractMentionIds,
} from '@kaxolax/contracts'
import { Exception } from '@adonisjs/core/exceptions'
import type { HttpContext } from '@adonisjs/core/http'
import db from '@adonisjs/lucid/services/db'
import type { QueryClientContract } from '@adonisjs/lucid/types/database'
import { DateTime } from 'luxon'
import ChatMessage from '#models/chat_message'
import type Project from '#models/project'
import type User from '#models/user'
import { PROJECT_ACCESS_VIEW, projectFor } from '#services/project_access'

/**
 * Chat du projet (contrats dans `packages/contracts/src/chat.ts`). Tout membre, lecteur compris,
 * lit et écrit : le chat n'est ni le texte du projet ni un commentaire ancré (permission `read`).
 */

export class ChatMessageNotFoundException extends Exception {
  static override status = 404
  static override code = 'E_CHAT_MESSAGE_NOT_FOUND'
  static override message = 'Chat message not found'
}

export class ChatRateLimitedException extends Exception {
  static override status = 429
  static override code = 'E_CHAT_RATE_LIMITED'
  static override message = 'Too many chat messages, try again later'

  constructor(readonly retryAfterSeconds: number) {
    super()
  }

  handle(_error: unknown, { response }: HttpContext) {
    response.header('retry-after', String(this.retryAfterSeconds))
    response.status(429).send({
      code: 'E_CHAT_RATE_LIMITED',
      message: this.message,
      retryAfterSeconds: this.retryAfterSeconds,
    })
  }
}

interface MessageRow {
  id: string
  body: string
  created_at: Date
  author_id: string
  full_name: string | null
  avatar_url: string | null
  deleted_at: Date | null
}

function serializeMessage(row: MessageRow): ChatMessageEntry {
  return {
    id: row.id,
    author: {
      id: row.author_id,
      // Compte supprimé : anonymisé, sans nom ni avatar.
      fullName: row.deleted_at === null ? row.full_name : null,
      avatarUrl: row.deleted_at === null ? row.avatar_url : null,
    },
    body: row.body,
    createdAt: row.created_at.toISOString(),
  }
}

function messagesQuery(client: QueryClientContract, projectId: string) {
  return client
    .from('chat_messages as m')
    .join('users as u', 'u.id', 'm.author_id')
    .where('m.project_id', projectId)
    .select(
      'm.id',
      'm.body',
      'm.created_at',
      'm.author_id',
      'u.full_name',
      'u.avatar_url',
      'u.deleted_at',
    )
}

/**
 * Non-lus d'un membre : messages des autres postérieurs à sa dernière lecture, ou à son arrivée
 * dans le projet s'il n'a jamais ouvert le chat (l'historique d'avant n'est pas « non lu »).
 */
export async function chatUnread(
  projectId: string,
  userId: string,
  client: QueryClientContract = db.connection(),
): Promise<ChatUnread> {
  const row = (await client
    .from(`${PROJECT_ACCESS_VIEW} as pm`)
    .leftJoin('chat_reads as r', (join) => {
      join.on('r.project_id', 'pm.project_id').andOn('r.user_id', 'pm.user_id')
    })
    .where('pm.project_id', projectId)
    .where('pm.user_id', userId)
    .select('r.last_read_at')
    .select(
      client.raw(
        `(SELECT count(*)::int FROM chat_messages m
           WHERE m.project_id = pm.project_id AND m.author_id <> pm.user_id
             AND m.created_at > coalesce(r.last_read_at, pm.joined_at)) AS unread`,
      ),
    )
    .first()) as { last_read_at: Date | null; unread: number } | null
  return {
    count: row?.unread ?? 0,
    lastReadAt: row?.last_read_at ? row.last_read_at.toISOString() : null,
  }
}

/** Message de référence d'un curseur, dans ce projet (404 sinon). */
async function referenceMessage(projectId: string, messageId: string): Promise<ChatMessage> {
  const message = await ChatMessage.query().where({ projectId, id: messageId }).first()
  if (!message) throw new ChatMessageNotFoundException()
  return message
}

/**
 * Une page de l'historique, du plus ancien au plus récent : les plus récents sans curseur,
 * ceux d'avant `before` ou d'après `after`. Ordre total (date, id) : deux messages de la même
 * milliseconde ne se perdent pas entre deux pages.
 */
export async function listChatMessages(
  user: User,
  projectId: string,
  query: ChatMessagesQuery,
): Promise<ChatMessagesResponse> {
  const { project } = await projectFor(user, projectId, 'read')
  const cursor = query.after ?? query.before
  const reference = cursor === undefined ? null : await referenceMessage(project.id, cursor)
  const forward = query.after !== undefined

  const rows = messagesQuery(db.connection(), project.id)
  if (reference) {
    void rows.whereRaw(`(m.created_at, m.id) ${forward ? '>' : '<'} (?::timestamptz, ?::uuid)`, [
      reference.createdAt.toJSDate(),
      reference.id,
    ])
  }
  const direction = forward ? 'asc' : 'desc'
  const page = (await rows
    .orderBy('m.created_at', direction)
    .orderBy('m.id', direction)
    .limit(query.limit + 1)) as MessageRow[]

  const hasMore = page.length > query.limit
  const kept = page.slice(0, query.limit)
  if (!forward) kept.reverse()
  return {
    messages: kept.map(serializeMessage),
    hasMore,
    unread: await chatUnread(project.id, user.id),
  }
}

/** Membre mentionné à notifier par email. */
export interface MentionNotice {
  userId: string
  email: string
}

export interface PostedChatMessage {
  project: Project
  message: ChatMessageEntry
  /** Membres mentionnés à prévenir (première mention non lue depuis leur dernière lecture). */
  notify: MentionNotice[]
  /** Noms des membres mentionnés (texte de l'email). */
  names: Map<string, string | null>
}

/**
 * Envoie un message (tout membre). Limite de débit par membre et par projet sur une fenêtre
 * glissante, sous verrou consultatif du projet (deux requêtes simultanées ne la dépassent pas).
 *
 * Mentions : seuls les membres actifs du projet, autres que l'auteur, sont retenus. Un email ne
 * part que pour la première mention non lue depuis la dernière lecture du chat par la personne :
 * au plus un email par visite manquée, quel que soit le nombre de mentions.
 */
export async function postChatMessage(
  user: User,
  projectId: string,
  body: string,
): Promise<PostedChatMessage> {
  return db.transaction(async (trx) => {
    const { project } = await projectFor(user, projectId, 'read', { trx })
    await trx.rawQuery('SELECT pg_advisory_xact_lock(hashtextextended(?, 0))', [
      `chat:${project.id}`,
    ])

    // Date du message donnée par PostgreSQL sous le verrou (pas par l'horloge de l'instance) et
    // strictement croissante dans le projet : le rattrapage `after` des clients ne la manque
    // jamais. Arrondie à la milliseconde, la précision des curseurs de pagination.
    const clock = (await trx
      .from('chat_messages')
      .where('project_id', project.id)
      .select(
        trx.raw(
          `GREATEST(date_trunc('milliseconds', clock_timestamp()),
             max(created_at) + interval '1 millisecond') AS now`,
        ),
      )
      .first()) as { now: Date }
    const now = DateTime.fromJSDate(clock.now)
    const windowStart = now.minus({ seconds: CHAT_RATE_LIMIT.windowSeconds })
    const recent = (await trx
      .from('chat_messages')
      .where({ project_id: project.id, author_id: user.id })
      .where('created_at', '>', windowStart.toJSDate())
      .orderBy('created_at', 'desc')
      .limit(CHAT_RATE_LIMIT.messages)
      .select('created_at')) as { created_at: Date }[]
    if (recent.length >= CHAT_RATE_LIMIT.messages) {
      // Le plus ancien message de la fenêtre en sort à cette date.
      const oldest = recent.at(-1)?.created_at.getTime() ?? now.toMillis()
      const wait = oldest + CHAT_RATE_LIMIT.windowSeconds * 1000 - now.toMillis()
      throw new ChatRateLimitedException(Math.max(1, Math.ceil(wait / 1000)))
    }

    const message = await ChatMessage.create(
      { projectId: project.id, authorId: user.id, body, createdAt: now },
      { client: trx },
    )

    const mentioned = extractMentionIds(body)
      .filter((id) => id !== user.id)
      .slice(0, CHAT_MAX_MENTIONS)
    const members =
      mentioned.length === 0
        ? []
        : ((await trx
            .from(`${PROJECT_ACCESS_VIEW} as pm`)
            .join('users as u', 'u.id', 'pm.user_id')
            .leftJoin('chat_reads as r', (join) => {
              join.on('r.project_id', 'pm.project_id').andOn('r.user_id', 'pm.user_id')
            })
            .where('pm.project_id', project.id)
            .whereIn('pm.user_id', mentioned)
            .whereNull('u.deleted_at')
            .whereNull('u.banned_at')
            .select('u.id', 'u.email', 'u.full_name')
            .select(
              trx.raw(
                `EXISTS (SELECT 1 FROM chat_messages m
                   WHERE m.project_id = pm.project_id AND m.id <> ?
                     AND m.author_id <> pm.user_id
                     AND m.created_at > coalesce(r.last_read_at, pm.joined_at)
                     AND m.body ILIKE '%<@' || pm.user_id::text || '>%') AS already_mentioned`,
                [message.id],
              ),
            )) as {
            id: string
            email: string
            full_name: string | null
            already_mentioned: boolean
          }[])

    const author = { id: user.id, fullName: user.fullName, avatarUrl: user.avatarUrl }
    return {
      project,
      message: {
        id: message.id,
        author,
        body: message.body,
        createdAt: message.createdAt.toJSDate().toISOString(),
      },
      notify: members
        .filter((member) => !member.already_mentioned && member.email !== '')
        .map((member) => ({ userId: member.id, email: member.email })),
      names: new Map(members.map((member) => [member.id, member.full_name])),
    }
  })
}

/**
 * Marque le chat comme lu jusqu'au message `upTo` (inclus), ou jusqu'à maintenant. La dernière
 * lecture ne recule jamais (deux onglets, requêtes croisées).
 */
export async function markChatRead(
  user: User,
  projectId: string,
  upTo: string | undefined,
): Promise<ChatUnread> {
  const { project } = await projectFor(user, projectId, 'read')
  // Sans `upTo` : l'horloge de PostgreSQL, celle des dates des messages.
  const readAt =
    upTo === undefined ? null : (await referenceMessage(project.id, upTo)).createdAt.toJSDate()
  await db.rawQuery(
    `INSERT INTO chat_reads (id, project_id, user_id, last_read_at)
     VALUES (?, ?, ?, coalesce(?::timestamptz, clock_timestamp()))
     ON CONFLICT (project_id, user_id)
     DO UPDATE SET last_read_at = GREATEST(chat_reads.last_read_at, EXCLUDED.last_read_at)`,
    [randomUUID(), project.id, user.id, readAt],
  )
  return chatUnread(project.id, user.id)
}

/** Longueur maximale de l'extrait d'un message dans l'email de mention. */
const EXCERPT_MAX_LENGTH = 500

/** Extrait d'un message pour un email : mentions remplacées par `@Nom`, longueur bornée. */
export function mentionExcerpt(body: string, names: ReadonlyMap<string, string | null>): string {
  const text = body.replaceAll(
    /<@([0-9a-f-]{36})>/gi,
    (_token, id: string) => `@${names.get(id.toLowerCase()) ?? 'membre'}`,
  )
  return text.length > EXCERPT_MAX_LENGTH ? `${text.slice(0, EXCERPT_MAX_LENGTH - 1)}…` : text
}
