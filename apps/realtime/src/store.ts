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

  async memberRole(projectId: string, userId: string): Promise<ProjectRole | null> {
    const result = await this.pool.query<{ role: string }>(
      'SELECT role FROM project_members WHERE project_id = $1 AND user_id = $2',
      [projectId, userId],
    )
    const role = result.rows[0]?.role
    return role === undefined ? null : projectRoleSchema.parse(role)
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
