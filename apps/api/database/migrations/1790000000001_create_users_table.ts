import { BaseSchema } from '@adonisjs/lucid/schema'

export default class extends BaseSchema {
  protected tableName = 'users'

  override async up() {
    this.schema.createTable(this.tableName, (table) => {
      table.uuid('id').primary().defaultTo(this.raw('gen_random_uuid()'))
      table.string('email', 254).notNullable().unique()
      table.string('password_hash').notNullable()
      table.string('full_name', 255).nullable()
      table.timestamp('email_verified_at', { useTz: true }).nullable()
      table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(this.now())
      table.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(this.now())
      // L'email est toujours stocké en minuscules.
      table.check('email = lower(email)', [], 'users_email_lowercase')
    })
  }

  override async down() {
    this.schema.dropTable(this.tableName)
  }
}
