import { randomUUID } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3'
import { importZip } from './index.js'

export interface ImportZipEvent {
  bucket: string
  /** Clé du zip uploadé. */
  key: string
  projectId: string
}

/**
 * Handler Lambda (étapes suivantes) : extrait le zip vers `projects/{projectId}/files/…` et
 * renvoie le plan d'import. À l'étape 1, l'API appelle directement importZip.
 */
export async function handler(event: ImportZipEvent) {
  const client = new S3Client({})
  const zipPath = join(tmpdir(), `kaxolax-import-${randomUUID()}.zip`)
  try {
    const object = await client.send(new GetObjectCommand({ Bucket: event.bucket, Key: event.key }))
    if (!(object.Body instanceof Readable)) throw new Error(`Empty S3 object: ${event.key}`)
    await pipeline(object.Body, createWriteStream(zipPath))
    const result = await importZip(zipPath, async ({ sizeBytes, mimeType, body }) => {
      const key = `projects/${event.projectId}/files/${randomUUID()}`
      await client.send(
        new PutObjectCommand({
          Bucket: event.bucket,
          Key: key,
          Body: body,
          ContentLength: sizeBytes,
          ContentType: mimeType,
        }),
      )
      return key
    })
    return {
      ...result,
      documents: result.documents.map(({ path, sha256 }) => ({ path, sha256 })),
    }
  } finally {
    await rm(zipPath, { force: true })
  }
}
