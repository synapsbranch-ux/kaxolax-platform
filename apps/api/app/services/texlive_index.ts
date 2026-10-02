import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import {
  MAX_MATCHING_STYLES,
  MAX_SUMMARY_STYLES,
  type PackageSuggestions,
  type TexliveIndex,
  texliveIndexSchema,
  type TexlivePackage,
  type TexlivePackageDetail,
  type TexlivePackageList,
  type TexlivePackagesQuery,
  type TexlivePackageSummary,
} from '@kaxolax/contracts'
import { Exception } from '@adonisjs/core/exceptions'
import logger from '@adonisjs/core/services/logger'
import texliveConfig from '#config/texlive'
import { BucketStorage } from '#services/object_storage'
import { type StyleEntry, suggestPackages } from '#services/package_suggestions'

/** Index absent (pas de bucket en production) ou illisible, sans copie en mémoire. */
export class PackageIndexUnavailableException extends Exception {
  static override status = 503
  static override code = 'E_PACKAGE_INDEX_UNAVAILABLE'
  static override message = 'The TeX Live package index is unavailable, try again later'
}

export class PackageNotFoundException extends Exception {
  static override status = 404
  static override code = 'E_PACKAGE_NOT_FOUND'
  static override message = 'Package not found'
}

/** Source de l'index : le stockage objet (lecture conditionnelle) ou un fichier local. */
export interface IndexSource {
  /** Null : inchangé depuis `etag`. */
  read(etag: string | null): Promise<{ text: string; etag: string | null } | null>
}

export interface TexliveIndexOptions {
  source: IndexSource
  refreshIntervalMs: number
  retryAfterErrorMs: number
  now?: () => number
}

/** Index chargé, avec ses tables de recherche. */
interface Loaded {
  index: TexliveIndex
  etag: string
  byName: Map<string, TexlivePackage>
  styles: StyleEntry[]
  /** Fichier de style → entrée (casse d'origine). */
  styleByFile: Map<string, StyleEntry>
  /** Texte de recherche de chaque package (minuscules) : nom, fichiers, description. */
  haystacks: Map<string, string>
}

function styleKind(file: string): StyleEntry['kind'] | null {
  if (file.endsWith('.sty')) return 'package'
  if (file.endsWith('.cls')) return 'class'
  return null
}

/** Noms à passer à `\usepackage` : le `.sty` du nom du package d'abord. */
function usepackageNames(entry: TexlivePackage, limit = Number.POSITIVE_INFINITY): string[] {
  const names = entry.styles
    .filter((file) => file.endsWith('.sty'))
    .map((file) => file.slice(0, -4))
  names.sort((a, b) => Number(b === entry.name) - Number(a === entry.name) || a.localeCompare(b))
  return names.slice(0, limit)
}

function prepare(index: TexliveIndex, etag: string): Loaded {
  const byName = new Map(index.packages.map((entry) => [entry.name, entry]))
  const styles: StyleEntry[] = []
  const styleByFile = new Map<string, StyleEntry>()
  for (const [file, packages] of Object.entries(index.byStyle)) {
    const kind = styleKind(file)
    if (kind === null) continue
    const entry = { name: file.slice(0, -4), file, kind, packages }
    styles.push(entry)
    styleByFile.set(file, entry)
  }
  const haystacks = new Map(
    index.packages.map((entry) => [
      entry.name,
      [entry.name, ...entry.styles, entry.shortdesc ?? ''].join(' ').toLowerCase(),
    ]),
  )
  return { index, etag, byName, styles, styleByFile, haystacks }
}

/** Résumé d'un package ; avec des mots cherchés, les noms `\usepackage` qui en contiennent un. */
function summary(entry: TexlivePackage, terms: readonly string[]): TexlivePackageSummary {
  const result: TexlivePackageSummary = {
    name: entry.name,
    shortdesc: entry.shortdesc,
    category: entry.category,
    topics: entry.topics,
    ctanUrl: entry.ctanUrl,
    docUrl: entry.docUrl,
    usepackage: usepackageNames(entry, MAX_SUMMARY_STYLES),
  }
  if (terms.length === 0) return result
  result.matchingUsepackage = usepackageNames(entry)
    .filter((name) => {
      const lower = name.toLowerCase()
      return terms.some((term) => lower.includes(term))
    })
    .slice(0, MAX_MATCHING_STYLES)
  return result
}

/** Score de pertinence d'un package pour une recherche (plus petit = meilleur). */
function relevance(entry: TexlivePackage, query: string, provides: Set<string>): number {
  const name = entry.name.toLowerCase()
  if (name === query) return 0
  if (provides.has(entry.name)) return 1
  if (name.startsWith(query)) return 2
  if (name.includes(query)) return 3
  if (entry.styles.some((file) => file.toLowerCase().startsWith(query))) return 4
  return 5
}

/**
 * Index des packages TeX Live en mémoire, partagé par les requêtes : chargé au premier appel,
 * revalidé (lecture conditionnelle sur l'ETag) après `refreshIntervalMs`, en arrière-plan
 * tant qu'une copie existe. Si la source échoue, la copie en mémoire continue de servir ; sans
 * copie, les appels répondent 503 sans relire la source jusqu'à `retryAfterErrorMs` après l'échec
 * (une panne ou une clé absente ne coûte pas une lecture du stockage par requête).
 */
export class TexliveIndexService {
  private loaded: Loaded | null = null
  private checkedAt = 0
  /** Dernier échec du chargement sans copie en mémoire. */
  private failedAt: number | null = null
  private loading: Promise<Loaded> | null = null

  constructor(private readonly options: TexliveIndexOptions) {}

  private now(): number {
    return (this.options.now ?? Date.now)()
  }

  /** Index courant ; attend le premier chargement, puis revalide sans faire attendre. */
  async current(): Promise<Loaded> {
    const loaded = this.loaded
    if (loaded && this.now() - this.checkedAt < this.options.refreshIntervalMs) return loaded
    if (
      !loaded &&
      this.failedAt !== null &&
      this.now() - this.failedAt < this.options.retryAfterErrorMs
    ) {
      throw new PackageIndexUnavailableException()
    }
    const refresh = this.refresh()
    if (loaded) {
      refresh.catch(() => undefined)
      return loaded
    }
    return refresh
  }

  /** Relit la source sans attendre l'échéance (attend une relecture déjà en cours). */
  async revalidate(): Promise<void> {
    await this.refresh()
  }

  private refresh(): Promise<Loaded> {
    this.loading ??= this.load().finally(() => {
      this.loading = null
    })
    return this.loading
  }

  private async load(): Promise<Loaded> {
    const previous = this.loaded
    try {
      const read = await this.options.source.read(previous?.etag ?? null)
      this.checkedAt = this.now()
      if (read === null && previous) return previous
      if (read === null) throw new Error('index source answered not modified without an index')
      const index = texliveIndexSchema.parse(JSON.parse(read.text))
      const etag = read.etag ?? createHash('sha256').update(read.text).digest('hex')
      this.loaded = prepare(index, etag)
      this.failedAt = null
      logger.info(
        { packages: index.packages.length, texliveYear: index.texliveYear },
        'TeX Live package index loaded',
      )
      return this.loaded
    } catch (error) {
      if (!previous) this.failedAt = this.now()
      if (error instanceof PackageIndexUnavailableException && !previous) throw error
      logger.warn({ err: error }, 'could not load the TeX Live package index')
      if (previous) {
        // Nouvel essai après `retryAfterErrorMs` ; la copie en mémoire sert jusque-là.
        this.checkedAt =
          this.now() - this.options.refreshIntervalMs + this.options.retryAfterErrorMs
        return previous
      }
      throw new PackageIndexUnavailableException(undefined, { cause: error })
    }
  }

  /** ETag de l'index courant (sert aux ETag des réponses). */
  async etag(): Promise<string> {
    return (await this.current()).etag
  }

  async search(query: TexlivePackagesQuery): Promise<TexlivePackageList> {
    const { index, haystacks, styleByFile } = await this.current()
    const text = query.q?.toLowerCase() ?? ''
    const terms = text.split(/\s+/).filter((term) => term !== '')
    const category = query.category?.toLowerCase()
    const topic = query.topic?.toLowerCase()
    // Packages qui fournissent exactement `<q>.sty` (graphicx → graphics).
    const provides = new Set(styleByFile.get(`${text}.sty`)?.packages ?? [])
    let matches = index.packages.filter(
      (entry) =>
        (category === undefined || entry.category.toLowerCase() === category) &&
        (topic === undefined || entry.topics.includes(topic)) &&
        terms.every((term) => haystacks.get(entry.name)?.includes(term) === true),
    )
    if (text !== '') {
      const scores = new Map(matches.map((entry) => [entry, relevance(entry, text, provides)]))
      matches = matches.toSorted(
        (a, b) => (scores.get(a) ?? 5) - (scores.get(b) ?? 5) || a.name.localeCompare(b.name),
      )
    }
    const start = (query.page - 1) * query.perPage
    return {
      texliveYear: index.texliveYear,
      total: matches.length,
      page: query.page,
      perPage: query.perPage,
      packages: matches.slice(start, start + query.perPage).map((entry) => summary(entry, terms)),
    }
  }

  /** Fiche d'un package, par son nom TeX Live ou par un fichier `.sty` qu'il fournit. */
  async show(name: string): Promise<TexlivePackageDetail> {
    const { index, byName, styleByFile } = await this.current()
    const entry = byName.get(name) ?? byName.get(styleByFile.get(`${name}.sty`)?.packages[0] ?? '')
    if (!entry) throw new PackageNotFoundException()
    return { ...entry, usepackage: usepackageNames(entry), texliveYear: index.texliveYear }
  }

  /**
   * Noms proches d'un package ou d'une classe introuvable : `amsmth` (ou `amsmth.sty`) →
   * `amsmath` ; `artcle.cls` cherche parmi les classes.
   */
  async suggest(name: string): Promise<PackageSuggestions> {
    const { styles, styleByFile, byName } = await this.current()
    const kind = name.endsWith('.cls') ? 'class' : 'package'
    const query = /\.(?:sty|cls)$/.test(name) ? name.slice(0, -4) : name
    const file = `${query}.${kind === 'class' ? 'cls' : 'sty'}`
    return {
      query,
      kind,
      exists: styleByFile.has(file),
      suggestions: suggestPackages(
        query,
        kind,
        styles,
        (packageName) => byName.get(packageName)?.shortdesc ?? null,
      ),
    }
  }
}

/** Index publié dans le stockage objet (bucket et clé de la configuration). */
export function bucketSource(bucket: string, key: string): IndexSource {
  const storage = new BucketStorage(bucket)
  return { read: (etag) => storage.readTextIfChanged(key, etag ?? undefined) }
}

/** Fichier local (fixture) : relu seulement au premier chargement. */
export function fileSource(path: string): IndexSource {
  return {
    read: async (etag) =>
      etag === null ? { text: await readFile(path, 'utf8'), etag: null } : null,
  }
}

/** Source configurée : bucket, sinon fixture (hors production), sinon indisponible (503). */
function configuredSource(): IndexSource {
  if (texliveConfig.indexBucket !== undefined) {
    return bucketSource(texliveConfig.indexBucket, texliveConfig.indexKey)
  }
  if (texliveConfig.allowFixture) return fileSource(texliveConfig.fixturePath)
  return { read: () => Promise.reject(new PackageIndexUnavailableException()) }
}

/** Instance partagée par les requêtes de l'API. */
export const texliveIndex = new TexliveIndexService({
  source: configuredSource(),
  refreshIntervalMs: texliveConfig.refreshIntervalMs,
  retryAfterErrorMs: texliveConfig.retryAfterErrorMs,
})
