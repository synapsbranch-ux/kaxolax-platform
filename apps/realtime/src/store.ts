import { type ProjectRole, projectRoleSchema } from '@kaxolax/contracts'
import pg from 'pg'

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
   * Rôle d'un membre du projet ; null s'il n'en est pas membre, si son compte est banni ou
   * supprimé, ou si ses sessions ont été révoquées après l'émission du jeton (`issuedAt`, en
   * secondes ; arrondi à la seconde : un jeton émis dans la seconde de la révocation est refusé).
   */
  async memberRole(
    projectId: string,
    userId: string,
    issuedAt: number,
  ): Promise<ProjectRole | null> {
    const result = await this.pool.query<{ role: string }>(
      `SELECT m.role FROM project_members m JOIN users u ON u.id = m.user_id
       WHERE m.project_id = $1 AND m.user_id = $2
         AND u.banned_at IS NULL AND u.deleted_at IS NULL
         AND (u.sessions_revoked_at IS NULL OR u.sessions_revoked_at <= to_timestamp($3))`,
      [projectId, userId, issuedAt],
    )
    const role = result.rows[0]?.role
    return role === undefined ? null : projectRoleSchema.parse(role)
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
