import { createHash, randomBytes } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { copyFile, mkdir, readdir, rename, rm, stat, utimes } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3'
import { type AgentConfig } from './config.js'
import { copyRegularFile, openRegularFile } from './regular-file.js'
import { type BinarySource } from './workspace.js'

export function createS3Client(config: AgentConfig): S3Client {
  return new S3Client({
    region: config.S3_REGION,
    ...(config.S3_ENDPOINT ? { endpoint: config.S3_ENDPOINT } : {}),
    forcePathStyle: config.S3_FORCE_PATH_STYLE,
    // Le checksum ajouté par défaut par le SDK n'est pas accepté par tous les stockages S3.
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
    ...(config.S3_ACCESS_KEY_ID && config.S3_SECRET_ACCESS_KEY
      ? {
          credentials: {
            accessKeyId: config.S3_ACCESS_KEY_ID,
            secretAccessKey: config.S3_SECRET_ACCESS_KEY,
          },
        }
      : {}),
  })
}

/** Fournit le flux d'un objet à mettre en cache. */
export type BinaryFetcher = (s3Key: string) => Promise<Readable>

export function s3Fetcher(client: S3Client, bucket: string): BinaryFetcher {
  return async (s3Key) => {
    const object = await client.send(new GetObjectCommand({ Bucket: bucket, Key: s3Key }))
    if (!(object.Body instanceof Readable)) throw new Error(`Empty S3 object: ${s3Key}`)
    return object.Body
  }
}

export class ChecksumMismatchError extends Error {}

/**
 * Cache local des fichiers binaires, indexé par sha256 et alimenté depuis S3. Le contenu téléchargé
 * est vérifié contre son sha256 avant d'entrer dans le cache ; un fichier du cache n'est jamais
 * monté tel quel dans un conteneur (il est copié dans le répertoire du projet).
 */
export class BinaryCache implements BinarySource {
  private readonly inFlight = new Map<string, Promise<string>>()

  constructor(
    private readonly cacheDir: string,
    private readonly fetch: BinaryFetcher,
  ) {}

  pathFor(sha256: string): string {
    return join(this.cacheDir, 'sha256', sha256.slice(0, 2), sha256)
  }

  async get(s3Key: string, sha256: string): Promise<string> {
    const target = this.pathFor(sha256)
    try {
      await stat(target)
      const now = new Date()
      await utimes(target, now, now)
      return target
    } catch {
      // Absent du cache : téléchargement (une seule fois pour des demandes simultanées).
    }
    const pending = this.inFlight.get(sha256)
    if (pending) return pending
    const download = this.download(s3Key, sha256, target).finally(() =>
      this.inFlight.delete(sha256),
    )
    this.inFlight.set(sha256, download)
    return download
  }

  async has(sha256: string): Promise<boolean> {
    return stat(this.pathFor(sha256)).then(
      () => true,
      () => false,
    )
  }

  /**
   * Ajoute au cache un contenu poussé par l'appelant (conteneur Cloudflare : le Worker lit R2 et
   * envoie le flux), vérifié contre son sha256 comme un téléchargement.
   */
  async store(sha256: string, source: Readable): Promise<void> {
    await this.ingest(source, sha256, `sha256:${sha256}`, this.pathFor(sha256))
  }

  /** Ajoute un fichier local au cache (utilisé par la ligne de commande). */
  async put(sourcePath: string, sha256: string): Promise<void> {
    const target = this.pathFor(sha256)
    await mkdir(dirname(target), { recursive: true })
    await copyFile(sourcePath, target)
  }

  private async download(s3Key: string, sha256: string, target: string): Promise<string> {
    return this.ingest(await this.fetch(s3Key), sha256, s3Key, target)
  }

  private async ingest(
    source: Readable,
    sha256: string,
    label: string,
    target: string,
  ): Promise<string> {
    const temporaryDir = join(this.cacheDir, 'tmp')
    await mkdir(temporaryDir, { recursive: true })
    await mkdir(dirname(target), { recursive: true })
    const temporary = join(temporaryDir, randomBytes(8).toString('hex'))
    const hash = createHash('sha256')
    const hasher = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        hash.update(chunk)
        callback(null, chunk)
      },
    })
    try {
      await pipeline(source, hasher, createWriteStream(temporary, { mode: 0o444 }))
      const actual = hash.digest('hex')
      if (actual !== sha256) {
        throw new ChecksumMismatchError(
          `sha256 mismatch for ${label}: expected ${sha256}, got ${actual}`,
        )
      }
      await rename(temporary, target)
      return target
    } finally {
      await rm(temporary, { force: true })
    }
  }

  /** Supprime les fichiers les moins récemment utilisés au-delà de `maxBytes`. */
  async prune(maxBytes: number): Promise<number> {
    const root = join(this.cacheDir, 'sha256')
    const files: { path: string; size: number; atime: number }[] = []
    for (const prefix of await readdir(root).catch(() => [])) {
      for (const name of await readdir(join(root, prefix)).catch(() => [])) {
        const path = join(root, prefix, name)
        const info = await stat(path).catch(() => null)
        if (info) files.push({ path, size: info.size, atime: info.mtimeMs })
      }
    }
    let total = files.reduce((sum, file) => sum + file.size, 0)
    let removed = 0
    for (const file of files.sort((a, b) => a.atime - b.atime)) {
      if (total <= maxBytes) break
      await rm(file.path, { force: true })
      total -= file.size
      removed++
    }
    return removed
  }
}

/** Destination des fichiers produits par une compilation. */
export interface OutputStore {
  put(bucket: string, key: string, filePath: string, contentType: string): Promise<void>
}

export class S3OutputStore implements OutputStore {
  constructor(private readonly client: S3Client) {}

  async put(bucket: string, key: string, filePath: string, contentType: string): Promise<void> {
    // Sortie de compilation : jamais à travers un lien symbolique (regular-file.ts).
    const handle = await openRegularFile(filePath)
    if (handle === null) throw new Error(`Not a regular file: ${filePath}`)
    try {
      const { size } = await handle.stat()
      await this.client.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          Body: handle.createReadStream({ autoClose: false }),
          ContentLength: size,
          ContentType: contentType,
        }),
      )
    } finally {
      await handle.close()
    }
  }
}

/** Copie les sorties dans un répertoire local (ligne de commande, tests). */
export class LocalOutputStore implements OutputStore {
  constructor(private readonly root: string) {}

  async put(bucket: string, key: string, filePath: string): Promise<void> {
    const target = join(this.root, bucket, key)
    await mkdir(dirname(target), { recursive: true })
    await copyRegularFile(filePath, target)
  }
}
