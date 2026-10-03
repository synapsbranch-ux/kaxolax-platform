import type { AiCreditKind, AiOperation } from '@kaxolax/contracts'
import { column } from '@adonisjs/lucid/orm'
import { type DateTime } from 'luxon'
import UuidModel from '#models/uuid_model'

const toNumber = (value: string | number) => Number(value)

/**
 * Un appel mesuré : utilisateur qui a lancé l'action (crédits imputés à son plan), projet et
 * workspace (null s'ils ont été supprimés depuis), opération, modèle, tokens et coût calculé.
 */
export default class AiUsage extends UuidModel {
  static override table = 'ai_usage'

  @column()
  declare userId: string

  @column()
  declare projectId: string | null

  @column()
  declare workspaceId: string | null

  @column()
  declare aiMessageId: string | null

  @column()
  declare operation: AiOperation

  @column()
  declare creditKind: AiCreditKind

  @column()
  declare model: string

  @column()
  declare inputTokens: number

  @column()
  declare outputTokens: number

  @column()
  declare cacheReadInputTokens: number

  @column()
  declare cacheCreationInputTokens: number

  /** Coût en micro-dollars (bigint, renvoyé en texte par pg). */
  @column({ consume: toNumber })
  declare costMicros: number

  @column()
  declare imageCount: number

  @column()
  declare stopReason: string | null

  @column()
  declare requestId: string | null

  @column.dateTime({ autoCreate: true })
  declare createdAt: DateTime
}
