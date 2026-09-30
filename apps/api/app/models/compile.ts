import { type Compiler, type CompileStatus } from '@kaxolax/contracts'
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

  @column()
  declare status: CompileStatus

  @column()
  declare durationMs: number

  @column()
  declare agentId: string | null

  @column()
  declare outputPrefix: string

  @column.dateTime({ autoCreate: true })
  declare createdAt: DateTime
}
