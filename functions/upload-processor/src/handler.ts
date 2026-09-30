import { Readable } from 'node:stream'
import { GetObjectCommand, HeadObjectCommand, NotFound, S3Client } from '@aws-sdk/client-s3'
import { type ProcessedUpload, processUpload, type UploadSource } from './index.js'

/** Lecture d'un bucket S3 pour processUpload. */
export function s3UploadSource(client: S3Client, bucket: string): UploadSource {
  return {
    async size(key) {
      try {
        const head = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }))
        return head.ContentLength ?? 0
      } catch (error) {
        if (error instanceof NotFound) return null
        throw error
      }
    },
    async read(key) {
      const object = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }))
      if (!(object.Body instanceof Readable)) throw new Error(`Empty S3 object: ${key}`)
      return object.Body
    },
  }
}

export interface ProcessUploadEvent {
  bucket: string
  key: string
  filename: string
  declaredSizeBytes: number
  maxSizeBytes: number
}

/**
 * Handler Lambda (étapes suivantes). À l'étape 1, l'API appelle directement processUpload.
 * Le contenu texte n'est pas renvoyé : seulement la classification et le sha256.
 */
export async function handler(
  event: ProcessUploadEvent,
): Promise<
  Exclude<ProcessedUpload, { kind: 'text' }> | { kind: 'text'; sha256: string; sizeBytes: number }
> {
  const result = await processUpload(event, s3UploadSource(new S3Client({}), event.bucket))
  if (result.kind === 'text') {
    return { kind: 'text', sha256: result.sha256, sizeBytes: result.sizeBytes }
  }
  return result
}
