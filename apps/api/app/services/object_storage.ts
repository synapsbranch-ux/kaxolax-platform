import { createWriteStream } from 'node:fs'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import {
  CopyObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  NotFound,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import type { UploadSource } from '@kaxolax/upload-processor'
import logger from '@adonisjs/core/services/logger'
import storageConfig from '#config/storage'

function createClient(endpoint: string | undefined): S3Client {
  const { accessKeyId, secretAccessKey } = storageConfig
  return new S3Client({
    region: storageConfig.region,
    ...(endpoint ? { endpoint } : {}),
    forcePathStyle: storageConfig.forcePathStyle,
    // Le checksum ajouté par défaut par le SDK n'est pas accepté par tous les stockages S3.
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
    ...(accessKeyId && secretAccessKey
      ? { credentials: { accessKeyId, secretAccessKey: secretAccessKey.release() } }
      : {}),
  })
}

// Deux clients : l'un parle à S3 depuis le serveur, l'autre signe des URL pour le navigateur
// (l'hôte fait partie de la signature). Partagés par toutes les requêtes.
let clients: { internal: S3Client; presigner: S3Client } | undefined
function s3() {
  clients ??= {
    internal: createClient(storageConfig.endpoint),
    presigner: createClient(storageConfig.publicEndpoint ?? storageConfig.endpoint),
  }
  return clients
}

export const uploadKey = (uploadId: string) => `uploads/${uploadId}`
export const projectPrefix = (projectId: string) => `projects/${projectId}/`
export const fileKey = (projectId: string, fileId: string) =>
  `${projectPrefix(projectId)}files/${fileId}`

/** Nom de fichier pour Content-Disposition (RFC 6266), sans caractère qui casserait l'en-tête. */
export function contentDisposition(mode: 'inline' | 'attachment', filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]|["\\]/g, '_')
  return `${mode}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`
}

/** Opérations sur un bucket S3. */
export class BucketStorage implements UploadSource {
  constructor(readonly bucket: string) {}

  /** URL de PUT présignée ; la taille est signée, S3 refuse un contenu d'une autre taille. */
  async presignUpload(key: string, sizeBytes: number): Promise<string> {
    return getSignedUrl(
      s3().presigner,
      new PutObjectCommand({ Bucket: this.bucket, Key: key, ContentLength: sizeBytes }),
      {
        expiresIn: storageConfig.uploadUrlTtlSeconds,
        signableHeaders: new Set(['content-length']),
      },
    )
  }

  async presignDownload(
    key: string,
    filename: string,
    options: { mode: 'inline' | 'attachment'; contentType: string; expiresIn?: number },
  ): Promise<string> {
    return getSignedUrl(
      s3().presigner,
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: key,
        ResponseContentDisposition: contentDisposition(options.mode, filename),
        ResponseContentType: options.contentType,
      }),
      { expiresIn: options.expiresIn ?? storageConfig.downloadUrlTtlSeconds },
    )
  }

  async size(key: string): Promise<number | null> {
    try {
      const head = await s3().internal.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: key }),
      )
      return head.ContentLength ?? 0
    } catch (error) {
      if (error instanceof NotFound) return null
      throw error
    }
  }

  async read(key: string): Promise<Readable> {
    const object = await s3().internal.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }))
    if (!(object.Body instanceof Readable)) throw new Error(`Empty S3 object: ${key}`)
    return object.Body
  }

  async download(key: string, destination: string): Promise<number> {
    let bytes = 0
    await pipeline(
      await this.read(key),
      async function* (source: AsyncIterable<Buffer>) {
        for await (const chunk of source) {
          bytes += chunk.byteLength
          yield chunk
        }
      },
      createWriteStream(destination, { flags: 'wx', mode: 0o600 }),
    )
    return bytes
  }

  async put(key: string, body: Readable, sizeBytes: number, contentType: string): Promise<void> {
    // Le SDK ne rend jamais la main si le flux du corps échoue : on annule alors la requête.
    const controller = new AbortController()
    const abort = (error: unknown) => {
      controller.abort(error)
    }
    body.once('error', abort)
    try {
      await s3().internal.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: key,
          Body: body,
          ContentLength: sizeBytes,
          ContentType: contentType,
        }),
        { abortSignal: controller.signal },
      )
    } finally {
      body.off('error', abort)
    }
  }

  async putBuffer(key: string, content: Buffer, contentType: string): Promise<void> {
    await s3().internal.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: content,
        ContentLength: content.byteLength,
        ContentType: contentType,
      }),
    )
  }

  async copy(from: string, to: string, contentType: string): Promise<void> {
    await s3().internal.send(
      new CopyObjectCommand({
        Bucket: this.bucket,
        CopySource: `${this.bucket}/${from.split('/').map(encodeURIComponent).join('/')}`,
        Key: to,
        ContentType: contentType,
        MetadataDirective: 'REPLACE',
      }),
    )
  }

  /** Suppression au mieux : un objet orphelin coûte moins qu'une requête en erreur. */
  async delete(keys: readonly string[]): Promise<void> {
    for (let index = 0; index < keys.length; index += 1000) {
      const batch = keys.slice(index, index + 1000)
      try {
        await s3().internal.send(
          new DeleteObjectsCommand({
            Bucket: this.bucket,
            Delete: { Objects: batch.map((Key) => ({ Key })), Quiet: true },
          }),
        )
      } catch (error) {
        logger.warn({ err: error, count: batch.length }, 'could not delete S3 objects')
      }
    }
  }

  async deletePrefix(prefix: string): Promise<void> {
    try {
      let token: string | undefined
      do {
        const page = await s3().internal.send(
          new ListObjectsV2Command({
            Bucket: this.bucket,
            Prefix: prefix,
            ContinuationToken: token,
          }),
        )
        const keys = (page.Contents ?? []).flatMap((object) => (object.Key ? [object.Key] : []))
        await this.delete(keys)
        token = page.IsTruncated === true ? page.NextContinuationToken : undefined
      } while (token)
    } catch (error) {
      logger.warn({ err: error, prefix }, 'could not delete S3 prefix')
    }
  }
}

/** Bucket des fichiers de projet (uploads en attente, binaires des projets). */
export default class ObjectStorage extends BucketStorage {
  constructor() {
    super(storageConfig.projectFilesBucket)
  }
}

/** Bucket des sorties de compilation (PDF, log ; expiration à 7 jours). */
export class CompileOutputStorage extends BucketStorage {
  constructor() {
    super(storageConfig.compileOutputsBucket)
  }
}
