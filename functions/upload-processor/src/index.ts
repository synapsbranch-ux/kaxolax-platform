import { createHash } from 'node:crypto'
import type { Readable } from 'node:stream'
import {
  hasTextDocumentExtension,
  isValidUtf8,
  MAX_TEXT_DOCUMENT_BYTES,
  mimeTypeFor,
} from '@kaxolax/contracts'

/** Accès en lecture à l'objet uploadé (S3 en production, mémoire dans les tests). */
export interface UploadSource {
  /** Taille de l'objet, ou null s'il n'existe pas. */
  size(key: string): Promise<number | null>
  read(key: string): Promise<Readable>
}

export interface ProcessUploadInput {
  key: string
  filename: string
  /** Taille annoncée par le navigateur à la création de l'URL présignée. */
  declaredSizeBytes: number
  maxSizeBytes: number
}

export type ProcessedUpload =
  | { kind: 'text'; content: string; sha256: string; sizeBytes: number }
  | { kind: 'binary'; sha256: string; sizeBytes: number; mimeType: string }

export type UploadRejection = 'E_UPLOAD_MISSING' | 'E_UPLOAD_SIZE_MISMATCH' | 'E_UPLOAD_TOO_LARGE'

export class UploadRejectedError extends Error {
  constructor(
    readonly code: UploadRejection,
    message: string,
  ) {
    super(message)
    this.name = 'UploadRejectedError'
  }
}

/**
 * Vérifie un objet uploadé par URL présignée (présence, taille annoncée, plafond), calcule son
 * sha256 et le classe : document texte (extension texte, moins de 2 Mo, UTF-8 valide) ou fichier
 * binaire. Ne modifie rien : l'appelant crée l'entité, puis déplace ou supprime l'objet.
 */
export async function processUpload(
  input: ProcessUploadInput,
  source: UploadSource,
): Promise<ProcessedUpload> {
  const size = await source.size(input.key)
  if (size === null) throw new UploadRejectedError('E_UPLOAD_MISSING', 'The upload was not found')
  if (size > input.maxSizeBytes) {
    throw new UploadRejectedError('E_UPLOAD_TOO_LARGE', 'The file is too large')
  }
  if (size !== input.declaredSizeBytes) {
    throw new UploadRejectedError('E_UPLOAD_SIZE_MISMATCH', 'The uploaded size does not match')
  }

  const keepContent = hasTextDocumentExtension(input.filename) && size < MAX_TEXT_DOCUMENT_BYTES
  const hash = createHash('sha256')
  const chunks: Buffer[] = []
  let read = 0
  for await (const chunk of await source.read(input.key)) {
    const bytes = chunk as Buffer
    read += bytes.byteLength
    // L'objet a pu être remplacé entre la vérification de taille et la lecture.
    if (read > size) break
    hash.update(bytes)
    if (keepContent) chunks.push(bytes)
  }
  if (read !== size) {
    throw new UploadRejectedError('E_UPLOAD_SIZE_MISMATCH', 'The upload changed while reading it')
  }

  const sha256 = hash.digest('hex')
  if (keepContent) {
    const content = Buffer.concat(chunks)
    if (isValidUtf8(content)) {
      return { kind: 'text', content: content.toString('utf8'), sha256, sizeBytes: size }
    }
  }
  return { kind: 'binary', sha256, sizeBytes: size, mimeType: mimeTypeFor(input.filename) }
}
