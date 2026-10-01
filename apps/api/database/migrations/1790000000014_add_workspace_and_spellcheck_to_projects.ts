import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * Chaque projet rejoint un workspace : workspace personnel créé (avec son propriétaire membre)
 * pour chaque compte qui n'en a pas, puis chaque projet rattaché à celui de son `owner_id`, dans
 * la transaction de la migration. Ajoute aussi la langue du correcteur orthographique.
 *
 * Coexistence pendant le déploiement : les migrations passent avant le basculement, alors que
 * l'API de l'étape 1 sert encore et crée des projets sans `workspace_id`. Le déclencheur
 * `projects_default_workspace_id` les rattache au workspace personnel du propriétaire (créé au
 * besoin) au lieu de les refuser. À retirer par une migration de la version suivante, quand plus
 * aucune instance de l'étape 1 ne tourne : le code de l'étape 2 renseigne toujours la colonne.
 */
export default class extends BaseSchema {
  protected tableName = 'projects'

  override async up() {
    this.schema.alterTable(this.tableName, (table) => {
      // Un workspace qui contient encore des projets ne peut pas être supprimé.
      table
        .uuid('workspace_id')
        .nullable()
        .references('id')
        .inTable('workspaces')
        .onDelete('RESTRICT')
      // Langues figées ici (@kaxolax/contracts, SPELLCHECK_LANGUAGES) : en ajouter une demande
      // une nouvelle migration.
      table.string('spellcheck_language', 10).notNullable().defaultTo('en')
      table.check(
        `spellcheck_language IN ('en', 'fr')`,
        [],
        'projects_spellcheck_language_supported',
      )
      table.index(['workspace_id'])
    })

    this.defer(async (db) => {
      // Comptes anonymisés compris : chaque ligne de users a son workspace personnel.
      await db.rawQuery(
        `INSERT INTO workspaces (id, name, type, owner_id)
         SELECT gen_random_uuid(), 'Personal workspace', 'personal', users.id FROM users
         ON CONFLICT (owner_id) WHERE type = 'personal' DO NOTHING`,
      )
      await db.rawQuery(
        `INSERT INTO workspace_members (id, workspace_id, user_id, role)
         SELECT gen_random_uuid(), id, owner_id, 'owner' FROM workspaces WHERE type = 'personal'
         ON CONFLICT (workspace_id, user_id) DO NOTHING`,
      )
      // updated_at inchangé : l'ordre du dashboard ne bouge pas.
      await db.rawQuery(
        `UPDATE projects SET workspace_id = workspaces.id
         FROM workspaces
         WHERE workspaces.owner_id = projects.owner_id
           AND workspaces.type = 'personal'
           AND projects.workspace_id IS NULL`,
      )
      const orphans = await db.from('projects').whereNull('workspace_id').count('* as total')
      const total = Number((orphans[0] as { total: string | number }).total)
      if (total > 0) {
        throw new Error(`${String(total)} project(s) could not be attached to a workspace`)
      }
    })

    this.schema.raw('ALTER TABLE projects ALTER COLUMN workspace_id SET NOT NULL')

    // Même logique que ensurePersonalWorkspace. Une insertion de l'ancienne API reçue pendant la
    // migration attend la fin de sa transaction (verrou sur projects), puis passe ici.
    this.schema.raw(`
      CREATE FUNCTION projects_default_workspace_id() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        INSERT INTO workspaces (id, name, type, owner_id)
        VALUES (gen_random_uuid(), 'Personal workspace', 'personal', NEW.owner_id)
        ON CONFLICT (owner_id) WHERE type = 'personal' DO NOTHING;
        SELECT id INTO STRICT NEW.workspace_id FROM workspaces
        WHERE owner_id = NEW.owner_id AND type = 'personal';
        INSERT INTO workspace_members (id, workspace_id, user_id, role)
        VALUES (gen_random_uuid(), NEW.workspace_id, NEW.owner_id, 'owner')
        ON CONFLICT (workspace_id, user_id) DO NOTHING;
        RETURN NEW;
      END
      $$`)
    this.schema.raw(
      `CREATE TRIGGER projects_default_workspace_id BEFORE INSERT ON projects
       FOR EACH ROW WHEN (NEW.workspace_id IS NULL)
       EXECUTE FUNCTION projects_default_workspace_id()`,
    )
  }

  override async down() {
    // Avant la colonne, dont dépend la condition du déclencheur. IF EXISTS : la version suivante
    // le retire, et une base locale a pu appliquer une version de travail de cette migration.
    this.schema.raw('DROP TRIGGER IF EXISTS projects_default_workspace_id ON projects')
    this.schema.raw('DROP FUNCTION IF EXISTS projects_default_workspace_id()')
    // Les workspaces restent : la migration précédente les supprime à son tour.
    this.schema.alterTable(this.tableName, (table) => {
      table.dropColumn('spellcheck_language')
      table.dropColumn('workspace_id')
    })
  }
}
