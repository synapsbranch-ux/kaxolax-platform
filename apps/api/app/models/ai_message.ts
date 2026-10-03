import type { AiContentBlock, AiMessageRole, AiMessageStatus } from '@kaxolax/contracts'
import { column } from '@adonisjs/lucid/orm'
import { type DateTime } from 'luxon'
import UuidModel from '#models/uuid_model'

/**
 * Message d'une conversation IA. `content` : blocs tels que renvoyés par l'API (texte, `thinking`
 * signés, `tool_use`, `tool_result`, `fallback`…), à renvoyer à l'identique au tour suivant.
 */
export default class AiMessage extends UuidModel {
  static override table = 'ai_messages'

  @column()
  declare conversationId: string

  @column()
  declare role: AiMessageRole

  /** Tableau jsonb, sérialisé explicitement : pg convertirait un tableau JavaScript. */
  @column({ prepare: (value: AiContentBlock[]) => JSON.stringify(value) })
  declare content: AiContentBlock[]

  @column()
  declare model: string | null

  @column()
  declare status: AiMessageStatus

  @column()
  declare stopReason: string | null

  /** `usage` de la réponse de l'API, tel quel. */
  @column({
    prepare: (value: Record<string, unknown> | null) =>
      value === null ? null : JSON.stringify(value),
  })
  declare usage: Record<string, unknown> | null

  @column()
  declare errorCode: string | null

  @column.dateTime({ autoCreate: true })
  declare createdAt: DateTime

  @column.dateTime({ autoCreate: true, autoUpdate: true })
  declare updatedAt: DateTime
}
