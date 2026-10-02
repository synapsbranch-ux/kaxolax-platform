import { type BuildStatus, type Compiler } from '@kaxolax/contracts'
import { BaseModel, column } from '@adonisjs/lucid/orm'
import { type DateTime } from 'luxon'

export default class Compile extends BaseModel {
  static override selfAssignPrimaryKey = true

  /** Le buildId de la compilation. */
  @column({ isPrimary: true })
  declare id: string

  @column()
  declare projectId: string

  @column()
  declare userId: string

  @column()
  declare compiler: Compiler

  /** Statuts finaux de l'étape 1, plus les états de la compilation asynchrone. */
  @column()
  declare status: BuildStatus

  @column()
  declare durationMs: number

  @column()
  declare agentId: string | null

  @column()
  declare outputPrefix: string

  /** `gateway` (synchrone, étape 1) ou `cloudflare` (asynchrone, Worker + Containers). */
  @column()
  declare backend: 'gateway' | 'cloudflare'

  @column()
  declare timeoutMs: number | null

  /** Numéro du dernier rappel du Worker appliqué (anti-rejeu). */
  @column()
  declare lastEventSeq: number

  @column.dateTime({ autoCreate: true })
  declare createdAt: DateTime

  @column.dateTime({ autoCreate: true, autoUpdate: true })
  declare updatedAt: DateTime | null

  @column.dateTime()
  declare finishedAt: DateTime | null
}
