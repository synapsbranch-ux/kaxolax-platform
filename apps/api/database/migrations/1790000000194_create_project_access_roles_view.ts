import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * Vue `project_access_roles` : rôle effectif de chaque personne sur chaque projet, seule lecture
 * des droits pour l'API (`projectFor`, listes de projets, mentions) et le service temps réel
 * (revérification des rôles). Deux sources :
 * - `member` : ligne de `project_members` (propriétaire, invitation, lien de partage) ;
 * - `team` : appartenance au workspace d'équipe du projet ; un administrateur (ou propriétaire)
 *   du workspace est propriétaire effectif, un membre reçoit `projects.team_role`.
 * Une personne qui a les deux garde le plus élevé (à rôle égal, la ligne `member`). Même règle que
 * `teamProjectRole` de `@kaxolax/contracts`. `joined_at` : arrivée par la source retenue. Les
 * filtres sur `project_id` et `user_id` (colonnes du DISTINCT ON) descendent dans les deux
 * branches : les index de project_members et workspace_members servent.
 */
export default class extends BaseSchema {
  override async up() {
    this.schema.raw(`
      CREATE VIEW project_access_roles AS
      SELECT DISTINCT ON (g.project_id, g.user_id)
             g.project_id, g.user_id, g.role, g.source, g.joined_at
        FROM (
          SELECT m.project_id, m.user_id, m.role::text AS role, 'member'::text AS source,
                 m.created_at AS joined_at
            FROM project_members m
          UNION ALL
          SELECT p.id, wm.user_id,
                 CASE WHEN wm.role IN ('owner', 'admin') THEN 'owner' ELSE p.team_role::text END,
                 'team'::text, wm.created_at
            FROM projects p
            JOIN workspaces w ON w.id = p.workspace_id AND w.type = 'team'
            JOIN workspace_members wm ON wm.workspace_id = w.id
        ) g
       ORDER BY g.project_id, g.user_id,
                CASE g.role WHEN 'owner' THEN 3 WHEN 'editor' THEN 2 WHEN 'reviewer' THEN 1
                            ELSE 0 END DESC,
                (g.source = 'member') DESC
    `)
  }

  override async down() {
    this.schema.raw('DROP VIEW project_access_roles')
  }
}
