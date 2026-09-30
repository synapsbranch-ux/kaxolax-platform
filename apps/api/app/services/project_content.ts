import { createHash } from 'node:crypto'
import { readDocumentText } from '@kaxolax/collab'
import Document from '#models/document'
import File from '#models/file'
import type RealtimeClient from '#services/realtime_client'
import { buildTree } from '#services/tree_service'

export interface ProjectContent {
  folders: string[]
  documents: { id: string; path: string; content: string; sha256: string }[]
  files: {
    id: string
    path: string
    s3Key: string
    sha256: string
    sizeBytes: number
    mimeType: string
  }[]
}

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex')

/**
 * Contenu d'un projet avec ses chemins : texte courant des documents (instantané du service temps
 * réel, ou état enregistré s'il ne répond pas) et fichiers binaires de la table files.
 */
export async function projectContent(
  realtime: RealtimeClient,
  projectId: string,
): Promise<ProjectContent> {
  const tree = await buildTree(projectId)
  const snapshot = await realtime.snapshot(projectId)
  const live = new Map(snapshot?.documents.map((document) => [document.id, document]) ?? [])
  // Documents absents de l'instantané (service indisponible, ou créés entre-temps) : état en base.
  const missing = tree.documents
    .filter((document) => !live.has(document.id))
    .map((document) => document.id)
  const stored =
    missing.length === 0
      ? []
      : await Document.query().whereIn('id', missing).select('id', 'yjsState')
  const storedText = new Map(
    stored.map((document) => [
      document.id,
      readDocumentText(document.yjsState ? new Uint8Array(document.yjsState) : null),
    ]),
  )
  const files = await File.query()
    .where('projectId', projectId)
    .select('id', 's3Key', 'sha256', 'sizeBytes', 'mimeType')
  const fileById = new Map(files.map((file) => [file.id, file]))

  return {
    folders: tree.folders.map((folder) => folder.path),
    documents: tree.documents.map((document) => {
      const snapshotDocument = live.get(document.id)
      const content = snapshotDocument?.content ?? storedText.get(document.id) ?? ''
      return {
        id: document.id,
        path: document.path,
        content,
        sha256: snapshotDocument?.sha256 ?? sha256(content),
      }
    }),
    files: tree.files.flatMap((entry) => {
      const file = fileById.get(entry.id)
      return file
        ? [
            {
              id: file.id,
              path: entry.path,
              s3Key: file.s3Key,
              sha256: file.sha256,
              sizeBytes: file.sizeBytes,
              mimeType: file.mimeType,
            },
          ]
        : []
    }),
  }
}
