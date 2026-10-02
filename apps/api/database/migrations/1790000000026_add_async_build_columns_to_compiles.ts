import { BaseSchema } from '@adonisjs/lucid/schema'

const STEP1_STATUSES = ['success', 'failure', 'timeout', 'error']
const BUILD_STATUSES = ['queued', 'preparing', 'running', ...STEP1_STATUSES, 'cancelled']
const ACTIVE_STATUSES = ['queued', 'preparing', 'running']

const inList = (values: string[]) => values.map((value) => `'${value}'`).join(', ')

/**
 * Compilation asynchrone (Cloudflare) : la ligne de `compiles` est créée à la demande (`queued`)
 * puis suit les rappels du Worker. Les lignes existantes (synchrones, déjà terminées) gardent
 * leurs valeurs : `backend = 'gateway'`, `finished_at = created_at`.
 */
export default class extends BaseSchema {
  protected tableName = 'compiles'

  override async up() {
    this.schema.alterTable(this.tableName, (table) => {
      table.string('backend', 16).notNullable().defaultTo('gateway')
      table.integer('timeout_ms').nullable()
      // Numéro du dernier rappel appliqué : un rappel rejoué ou en retard est ignoré.
      table.integer('last_event_seq').notNullable().defaultTo(0)
      table.timestamp('updated_at', { useTz: true }).nullable()
      table.timestamp('finished_at', { useTz: true }).nullable()
      table.integer('duration_ms').notNullable().defaultTo(0).alter()
    })
    this.defer(async (db) => {
      await db.rawQuery('UPDATE compiles SET updated_at = created_at, finished_at = created_at')
    })
    this.schema.raw('ALTER TABLE compiles DROP CONSTRAINT compiles_status_check')
    this.schema.raw(
      `ALTER TABLE compiles ADD CONSTRAINT compiles_status_check CHECK (status IN (${inList(BUILD_STATUSES)}))`,
    )
    this.schema.raw(
      `ALTER TABLE compiles ADD CONSTRAINT compiles_backend_check CHECK (backend IN ('gateway', 'cloudflare'))`,
    )
    // Une seule compilation en cours par projet, garanti par la base.
    this.schema.raw(
      `CREATE UNIQUE INDEX compiles_one_active_per_project ON compiles (project_id) WHERE status IN (${inList(ACTIVE_STATUSES)})`,
    )
  }

  override async down() {
    // Sans perte de ligne : une compilation en cours ou annulée redevient une erreur.
    this.schema.raw('DROP INDEX compiles_one_active_per_project')
    this.schema.raw(
      `UPDATE compiles SET status = 'error' WHERE status NOT IN (${inList(STEP1_STATUSES)})`,
    )
    this.schema.raw('ALTER TABLE compiles DROP CONSTRAINT compiles_status_check')
    this.schema.raw(
      `ALTER TABLE compiles ADD CONSTRAINT compiles_status_check CHECK (status IN (${inList(STEP1_STATUSES)}))`,
    )
    this.schema.raw('ALTER TABLE compiles DROP CONSTRAINT compiles_backend_check')
    this.schema.alterTable(this.tableName, (table) => {
      table.dropColumn('backend')
      table.dropColumn('timeout_ms')
      table.dropColumn('last_event_seq')
      table.dropColumn('updated_at')
      table.dropColumn('finished_at')
      table.integer('duration_ms').notNullable().alter({ alterNullable: false })
    })
  }
}
