import { z } from 'zod'
import { sha256Schema } from './common.js'

/** Contenu texte courant d'un document, tel que le voit le service temps réel. */
export const documentSnapshotSchema = z.object({
  id: z.uuid(),
  content: z.string(),
  sha256: sha256Schema,
})
export type DocumentSnapshot = z.infer<typeof documentSnapshotSchema>

/** GET /internal/projects/:id/snapshot du service temps réel. */
export const projectSnapshotSchema = z.object({
  projectId: z.uuid(),
  documents: z.array(documentSnapshotSchema),
})
export type ProjectSnapshot = z.infer<typeof projectSnapshotSchema>

/** POST /internal/documents/:id/close du service temps réel. */
export const closeDocumentResponseSchema = z.object({ closed: z.boolean() })
export type CloseDocumentResponse = z.infer<typeof closeDocumentResponseSchema>
