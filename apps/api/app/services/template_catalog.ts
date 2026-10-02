import { createHash } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { readFile, rm } from 'node:fs/promises'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import {
  type CatalogFile,
  type CatalogTemplate,
  MAX_IMPORT_ZIP_BYTES,
  TEMPLATE_ERRORS,
  type TemplateCatalog,
  templateCatalogSchema,
  type TemplateSummary,
} from '@kaxolax/contracts'
import { Exception } from '@adonisjs/core/exceptions'
import logger from '@adonisjs/core/services/logger'
import templatesConfig from '#config/templates'

export class TemplatesUnavailableException extends Exception {
  static override status = 503
  static override code = TEMPLATE_ERRORS.catalogUnavailable
  static override message = 'The template gallery is unavailable, try again later'
}

export class TemplateNotFoundException extends Exception {
  static override status = 404
  static override code = TEMPLATE_ERRORS.notFound
  static override message = 'Template not found'
}

/** Zip du template injoignable, ou différent de ce qu'annonce le catalogue : 502. */
export class TemplateDownloadException extends Exception {
  static override status = 502
}

interface CachedCatalog {
  catalog: TemplateCatalog
  /** Dernière confirmation par le serveur (200 ou 304). */
  checkedAt: number
  etag: string | null
  lastModified: string | null
}

let cached: CachedCatalog | null = null
/** Pas de nouvel essai avant cette date après un échec (le catalogue en cache reste servi). */
let retryAfter = 0
/** Rafraîchissement en cours, partagé par les requêtes simultanées. */
let refreshing: Promise<TemplateCatalog> | null = null
let fixture: Promise<TemplateCatalog> | null = null

/** Oublie le catalogue en mémoire (tests, changement de configuration). */
export function resetTemplateCatalogCache(): void {
  cached = null
  retryAfter = 0
  refreshing = null
  fixture = null
}

/** Lit au plus `max` octets d'un corps de réponse ; au-delà, erreur. */
async function readCapped(body: ReadableStream<Uint8Array> | null, max: number): Promise<Buffer> {
  if (body === null) return Buffer.alloc(0)
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of Readable.fromWeb(body) as AsyncIterable<Buffer>) {
    total += chunk.length
    if (total > max) throw new Error(`Body larger than ${String(max)} bytes`)
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

function parseCatalog(text: string): TemplateCatalog {
  const parsed = templateCatalogSchema.safeParse(JSON.parse(text))
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    throw new Error(
      `Invalid template catalog: ${issue ? `${issue.path.join('.')}: ${issue.message}` : 'unknown'}`,
    )
  }
  return parsed.data
}

async function fetchCatalog(url: string): Promise<TemplateCatalog> {
  const headers: Record<string, string> = { accept: 'application/json' }
  if (cached?.etag) headers['if-none-match'] = cached.etag
  if (cached?.lastModified) headers['if-modified-since'] = cached.lastModified
  const response = await fetch(url, {
    headers,
    signal: AbortSignal.timeout(templatesConfig.fetchTimeoutMs),
  })
  if (response.status === 304 && cached !== null) {
    cached.checkedAt = Date.now()
    await response.body?.cancel()
    return cached.catalog
  }
  if (!response.ok) {
    await response.body?.cancel()
    throw new Error(`Template catalog request failed (${String(response.status)})`)
  }
  const body = await readCapped(response.body, templatesConfig.maxCatalogBytes)
  const catalog = parseCatalog(body.toString('utf8'))
  cached = {
    catalog,
    checkedAt: Date.now(),
    etag: response.headers.get('etag'),
    lastModified: response.headers.get('last-modified'),
  }
  return catalog
}

/**
 * Catalogue courant. Servi depuis la mémoire pendant `freshMs`, puis revalidé (requête
 * conditionnelle). Si le catalogue distant est injoignable ou invalide, la dernière copie valide
 * reste servie jusqu'à `staleMaxMs` ; sans copie : 503 `E_TEMPLATES_UNAVAILABLE`.
 */
export async function loadTemplateCatalog(): Promise<TemplateCatalog> {
  const url = templatesConfig.catalogUrl
  if (url === null) {
    if (templatesConfig.fixturePath === null) throw new TemplatesUnavailableException()
    const path = templatesConfig.fixturePath
    fixture ??= readFile(path, 'utf8').then(parseCatalog)
    return fixture.catch((error: unknown) => {
      fixture = null
      logger.error({ err: error, path }, 'template catalog fixture is invalid')
      throw new TemplatesUnavailableException()
    })
  }

  const now = Date.now()
  if (cached !== null && now - cached.checkedAt < templatesConfig.freshMs) return cached.catalog
  // Après un échec, pas de nouvel essai avant `retryAfter`, même sans copie en cache (503 immédiat).
  if (now < retryAfter) return staleOrFail(now)
  refreshing ??= fetchCatalog(url).finally(() => {
    refreshing = null
  })
  try {
    return await refreshing
  } catch (error) {
    retryAfter = Date.now() + templatesConfig.retryMs
    logger.warn({ err: error, url }, 'template catalog refresh failed')
    return staleOrFail(Date.now())
  }
}

function staleOrFail(now: number): TemplateCatalog {
  if (cached !== null && now - cached.checkedAt < templatesConfig.staleMaxMs) return cached.catalog
  throw new TemplatesUnavailableException()
}

/**
 * URL publique d'un fichier du catalogue, avec `?v=<sha256 court>` (cache d'une heure de R2).
 * Toute URL résolue hors de la base publique (autre origine ou autre dossier) rend le catalogue
 * invalide : 503, ni requête serveur ni lien envoyé aux navigateurs.
 */
export function templateFileUrl(file: CatalogFile): string | null {
  const base = templatesConfig.publicUrl
  if (base === null) return null
  const baseUrl = new URL(base)
  const url = new URL(file.path, baseUrl)
  if (url.origin !== baseUrl.origin || !url.pathname.startsWith(baseUrl.pathname)) {
    logger.error({ path: file.path }, 'template catalog path resolves outside the public base')
    throw new TemplatesUnavailableException()
  }
  url.searchParams.set('v', file.sha256.slice(0, 12))
  return url.toString()
}

/** Fiche servie aux navigateurs : métadonnées et URL publiques de la miniature et du PDF. */
export function templateSummary(template: CatalogTemplate): TemplateSummary {
  const { files, ...metadata } = template
  return {
    ...metadata,
    thumbnail: {
      url: templateFileUrl(files.thumbnail),
      width: files.thumbnail.width,
      height: files.thumbnail.height,
    },
    pdf: { url: templateFileUrl(files.pdf), bytes: files.pdf.bytes },
    zipBytes: files.zip.bytes,
  }
}

export async function findTemplate(id: string): Promise<CatalogTemplate> {
  const template = (await loadTemplateCatalog()).templates.find((entry) => entry.id === id)
  if (!template) throw new TemplateNotFoundException()
  return template
}

/**
 * Télécharge le zip d'un template dans `destination` et vérifie sa taille et son sha256 contre le
 * catalogue (lecture interrompue dès que la taille annoncée est dépassée). En cas d'échec, le
 * fichier est supprimé.
 */
export async function downloadTemplateZip(
  template: CatalogTemplate,
  destination: string,
): Promise<void> {
  const expected = template.files.zip
  const url = templateFileUrl(expected)
  if (url === null) throw new TemplatesUnavailableException()
  const integrity = (message: string) =>
    new TemplateDownloadException(message, { code: TEMPLATE_ERRORS.integrity })
  if (expected.bytes > MAX_IMPORT_ZIP_BYTES) throw integrity('The template archive is too large')

  let response: Response
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(templatesConfig.downloadTimeoutMs) })
  } catch (error) {
    logger.warn({ err: error, templateId: template.id }, 'template download failed')
    throw new TemplateDownloadException('The template archive could not be downloaded', {
      code: TEMPLATE_ERRORS.downloadFailed,
    })
  }
  if (!response.ok || response.body === null) {
    await response.body?.cancel()
    logger.warn({ status: response.status, templateId: template.id }, 'template download failed')
    throw new TemplateDownloadException('The template archive could not be downloaded', {
      code: TEMPLATE_ERRORS.downloadFailed,
    })
  }

  const hash = createHash('sha256')
  let size = 0
  const meter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      size += chunk.length
      if (size > expected.bytes) {
        callback(integrity('The template archive does not match the catalog'))
        return
      }
      hash.update(chunk)
      callback(null, chunk)
    },
  })
  try {
    await pipeline(Readable.fromWeb(response.body), meter, createWriteStream(destination))
  } catch (error) {
    await rm(destination, { force: true })
    if (error instanceof TemplateDownloadException) throw error
    logger.warn({ err: error, templateId: template.id }, 'template download interrupted')
    throw new TemplateDownloadException('The template archive could not be downloaded', {
      code: TEMPLATE_ERRORS.downloadFailed,
    })
  }
  if (size !== expected.bytes || hash.digest('hex') !== expected.sha256) {
    await rm(destination, { force: true })
    logger.error({ templateId: template.id, size }, 'template archive does not match the catalog')
    throw integrity('The template archive does not match the catalog')
  }
}
