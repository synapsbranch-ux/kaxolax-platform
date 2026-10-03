import { type ProjectRole, projectRoleSchema } from '@kaxolax/contracts'
import pg from 'pg'

/**
 * Projets du compte d'un projet (`p`), d'après la ligne `sizes` : tous ceux de son workspace
 * d'équipe, sinon les projets personnels de son propriétaire (hors équipes), comme
 * `storageUsage` de l'API.
 */
const ACCOUNT_PROJECTS = `CASE WHEN sizes.team_org IS NOT NULL
                                THEN p.workspace_id = sizes.workspace_id
                                ELSE p.owner_id = sizes.owner_id
                                     AND NOT EXISTS (SELECT 1 FROM workspaces w
                                                      WHERE w.id = p.workspace_id
                                                        AND w.type = 'team') END`

/** Accès à PostgreSQL : seulement les colonnes dont le service temps réel a besoin. */
export class DocumentStore {
  constructor(private readonly pool: pg.Pool) {}

  static connect(databaseUrl: string, ssl: boolean): DocumentStore {
    return new DocumentStore(
      new pg.Pool({
        connectionString: databaseUrl,
        ssl: ssl ? { rejectUnauthorized: true } : false,
        max: 10,
      }),
    )
  }

  /**
   * Rôle effectif d'une personne sur le projet (vue `project_access_roles` de l'API : membre du
   * projet, ou membre de son workspace d'équipe, le plus élevé des deux) ; null sans accès, si son
   * compte est banni ou supprimé, ou si ses sessions ont été révoquées après l'émission du jeton
   * (`issuedAt`, en secondes ; arrondi à la seconde : un jeton émis dans la seconde de la
   * révocation est refusé). Un membre retiré de l'équipe perd donc l'accès à la relecture.
   */
  async memberRole(
    projectId: string,
    userId: string,
    issuedAt: number,
  ): Promise<ProjectRole | null> {
    const result = await this.pool.query<{ role: string }>(
      `SELECT m.role FROM project_access_roles m JOIN users u ON u.id = m.user_id
       WHERE m.project_id = $1 AND m.user_id = $2
         AND u.banned_at IS NULL AND u.deleted_at IS NULL
         AND (u.sessions_revoked_at IS NULL OR u.sessions_revoked_at <= to_timestamp($3))`,
      [projectId, userId, issuedAt],
    )
    const role = result.rows[0]?.role
    return role === undefined ? null : projectRoleSchema.parse(role)
  }

  /**
   * Vrai si le compte peut garder son canal temps réel (`user:{id}`) : ni banni, ni supprimé, et
   * sessions non révoquées après l'émission du jeton (`issuedAt`, en secondes, comme
   * `memberRole`).
   */
  async accountActive(userId: string, issuedAt: number): Promise<boolean> {
    const result = await this.pool.query(
      `SELECT 1 FROM users u
       WHERE u.id = $1 AND u.banned_at IS NULL AND u.deleted_at IS NULL
         AND (u.sessions_revoked_at IS NULL OR u.sessions_revoked_at <= to_timestamp($2))`,
      [userId, issuedAt],
    )
    return result.rowCount === 1
  }

  /**
   * Identité affichée d'un compte dans la présence : nom complet et photo de profil (miroir
   * Clerk), jamais l'email (la présence est visible de tous les membres) ; null s'il n'existe pas.
   */
  async presenceProfile(
    userId: string,
  ): Promise<{ fullName: string | null; avatarUrl: string | null } | null> {
    const result = await this.pool.query<{ full_name: string | null; avatar_url: string | null }>(
      'SELECT full_name, avatar_url FROM users WHERE id = $1',
      [userId],
    )
    const row = result.rows[0]
    return row ? { fullName: row.full_name, avatarUrl: row.avatar_url } : null
  }

  async documentExists(projectId: string, documentId: string): Promise<boolean> {
    const result = await this.pool.query(
      'SELECT 1 FROM documents WHERE id = $1 AND project_id = $2',
      [documentId, projectId],
    )
    return result.rowCount === 1
  }

  async fetchState(projectId: string, documentId: string): Promise<Uint8Array | null> {
    const result = await this.pool.query<{ yjs_state: Buffer | null }>(
      'SELECT yjs_state FROM documents WHERE id = $1 AND project_id = $2',
      [documentId, projectId],
    )
    const state = result.rows[0]?.yjs_state
    return state ? new Uint8Array(state) : null
  }

  /**
   * Enregistre l'état Yjs si le texte a changé (une ouverture sans modification n'écrit rien), et
   * met à jour la date du projet. Renvoie vrai si une écriture a eu lieu.
   */
  async storeState(
    projectId: string,
    documentId: string,
    state: Uint8Array,
    sha256: string,
  ): Promise<boolean> {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      const updated = await client.query(
        `UPDATE documents SET yjs_state = $3, content_sha256 = $4, updated_at = now()
         WHERE id = $1 AND project_id = $2 AND content_sha256 IS DISTINCT FROM $4`,
        [documentId, projectId, Buffer.from(state), sha256],
      )
      if (updated.rowCount === 1) {
        await client.query('UPDATE projects SET updated_at = now() WHERE id = $1', [projectId])
      }
      await client.query('COMMIT')
      return updated.rowCount === 1
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  }

  /**
   * Ajoute des mises à jour Yjs au journal de l'historique (table document_updates), dans
   * l'ordre donné (ordre du rejeu). `userId` nul : origine inconnue.
   */
  async insertUpdates(
    rows: readonly {
      projectId: string
      documentId: string
      userId: string | null
      update: Uint8Array
    }[],
  ): Promise<void> {
    if (rows.length === 0) return
    const values: unknown[] = []
    const tuples = rows.map((row, index) => {
      values.push(row.projectId, row.documentId, row.userId, Buffer.from(row.update))
      const first = index * 4
      return `($${String(first + 1)}, $${String(first + 2)}, $${String(first + 3)}, $${String(first + 4)})`
    })
    await this.pool.query(
      `INSERT INTO document_updates (project_id, document_id, user_id, yjs_update) VALUES ${tuples.join(', ')}`,
      values,
    )
  }

  /**
   * Stockage du compte d'un projet : octets utilisés (fichiers et états Yjs enregistrés) et limite
   * de son plan. Même règle que l'API (`#services/entitlements`, `#services/plan_enforcement`)
   * sans les claims de la requête :
   * - projet personnel : projets personnels du propriétaire ; relevé des claims du compte s'il est
   *   plus récent que le miroir des webhooks (et date de moins de 35 jours), sinon plan du miroir,
   *   sinon `free` ; valeur de plan_limits, ramenée à celle de Free si la feature `extra_storage`
   *   manque au relevé ;
   * - projet d'équipe : tous les projets du workspace (stockage mutualisé), plan de
   *   l'organisation d'après le miroir des abonnements d'organisation, sinon `free`.
   * `ownerId` : propriétaire du projet (seul destinataire de l'usage). Null si le projet n'existe
   * plus.
   */
  async ownerStorage(
    projectId: string,
  ): Promise<{ ownerId: string; plan: string; limit: number; used: number } | null> {
    const result = await this.pool.query<{
      owner_id: string
      plan: string
      limit_bytes: string
      used: string
    }>(
      `WITH owner AS (
         SELECT u.id, u.claimed_plan_slug, u.claimed_plan_features, p.workspace_id,
                w.clerk_organization_id AS team_org,
                (w.clerk_organization_id IS NULL
                 AND u.claimed_plan_slug IS NOT NULL
                 AND u.claimed_plan_at > now() - make_interval(days => 35)
                 AND NOT EXISTS (SELECT 1 FROM subscriptions s
                                  WHERE s.user_id = u.id AND s.updated_at >= u.claimed_plan_at))
                  AS use_claims
           FROM projects p JOIN users u ON u.id = p.owner_id
           LEFT JOIN workspaces w ON w.id = p.workspace_id AND w.type = 'team'
          WHERE p.id = $1
       ),
       mirror AS (
         SELECT s.plan_slug FROM subscriptions s JOIN owner
             ON (owner.team_org IS NULL AND s.user_id = owner.id)
             OR (owner.team_org IS NOT NULL AND s.clerk_organization_id = owner.team_org)
          WHERE s.status IN ('active', 'past_due')
             OR (s.status = 'canceled' AND s.period_end > now())
          ORDER BY (s.plan_slug = 'free') ASC, s.updated_at DESC
          LIMIT 1
       ),
       plan AS (
         SELECT owner.id AS owner_id, owner.workspace_id, owner.team_org, owner.use_claims,
                owner.claimed_plan_features AS features,
                CASE WHEN owner.use_claims THEN owner.claimed_plan_slug
                     ELSE COALESCE((SELECT plan_slug FROM mirror), 'free') END AS slug
           FROM owner
       ),
       sizes AS (
         SELECT plan.*,
                COALESCE((SELECT storage_bytes FROM plan_limits WHERE plan_slug = 'free'),
                         524288000) AS free_bytes,
                (SELECT storage_bytes FROM plan_limits WHERE plan_slug = plan.slug) AS plan_bytes
           FROM plan
       )
       SELECT owner_id, slug AS plan,
              CASE WHEN NOT use_claims OR 'extra_storage' = ANY(features)
                   THEN COALESCE(plan_bytes, free_bytes)
                   ELSE LEAST(COALESCE(plan_bytes, free_bytes), free_bytes) END AS limit_bytes,
              (SELECT COALESCE(SUM(f.size_bytes), 0) FROM files f
                 JOIN projects p ON p.id = f.project_id WHERE ${ACCOUNT_PROJECTS})
              + (SELECT COALESCE(SUM(octet_length(d.yjs_state)), 0) FROM documents d
                 JOIN projects p ON p.id = d.project_id WHERE ${ACCOUNT_PROJECTS})
                AS used
         FROM sizes`,
      [projectId],
    )
    const row = result.rows[0]
    if (!row) return null
    // bigint et numeric : renvoyés en texte par pg.
    return {
      ownerId: row.owner_id,
      plan: row.plan,
      limit: Number(row.limit_bytes),
      used: Number(row.used),
    }
  }

  async documentIds(projectId: string): Promise<string[]> {
    const result = await this.pool.query<{ id: string }>(
      'SELECT id FROM documents WHERE project_id = $1 ORDER BY id',
      [projectId],
    )
    return result.rows.map((row) => row.id)
  }

  async close(): Promise<void> {
    await this.pool.end()
  }
}
