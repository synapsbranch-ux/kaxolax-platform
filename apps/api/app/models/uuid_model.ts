import { randomUUID } from 'node:crypto'
import { BaseModel, beforeCreate, column } from '@adonisjs/lucid/orm'

/** Modèle à clé primaire UUID, générée côté application. */
export default class UuidModel extends BaseModel {
  static override selfAssignPrimaryKey = true

  @column({ isPrimary: true })
  declare id: string

  @beforeCreate()
  static assignId(model: UuidModel) {
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- absent avant création
    model.id ??= randomUUID()
  }
}
