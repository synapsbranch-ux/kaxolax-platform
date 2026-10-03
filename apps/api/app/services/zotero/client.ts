import type { ZoteroExportFormat, ZoteroLibraryType } from '@kaxolax/contracts'
import logger from '@adonisjs/core/services/logger'
import zoteroConfig from '#config/zotero'
import {
  ZoteroOAuthFailedException,
  ZoteroRequestFailedException,
  ZoteroUnavailableException,
} from '#services/zotero/errors'
import { authorizationHeader } from '#services/zotero/oauth1'

/**
 * Appels à Zotero : OAuth 1.0a (www.zotero.org/oauth) et API Web v3 (api.zotero.org, en-tête
 * `Zotero-API-Version: 3`, clé dans `Zotero-API-Key`). Résolu par le conteneur AdonisJS ; les
 * tests le construisent avec un faux `fetch` (tests/zotero.ts), sans réseau. Le client ne garde
 * aucun état : les pauses demandées par Zotero (`Backoff`, `Retry-After`) sont rendues à
 * l'appelant, qui les enregistre sur le lien.
 */

export interface ZoteroLibraryRef {
  type: ZoteroLibraryType
  id: string
}

/** Chemin d'une bibliothèque dans l'API (`/users/123` ou `/groups/456`). */
export function libraryPath(library: ZoteroLibraryRef): string {
  return `/${library.type === 'user' ? 'users' : 'groups'}/${library.id}`
}

/** Réponse en erreur de l'API (`status` 0 : pas de réponse, délai dépassé). */
export class ZoteroHttpError extends Error {
  constructor(
    readonly status: number,
    /** `Retry-After` (ou `Backoff`) de la réponse, en secondes. */
    readonly retryAfterSeconds: number | null,
  ) {
    super(`Zotero answered ${String(status)}`)
    this.name = 'ZoteroHttpError'
  }
}

/** Valeur et pause demandée par Zotero pendant l'appel (en-tête `Backoff`, en secondes). */
export interface ZoteroResult<T> {
  value: T
  backoffSeconds: number | null
}

/**
 * Droits de lecture réellement accordés à la clé (objet `access` de `GET /keys/current`) :
 * l'utilisateur peut les réduire sur la page d'autorisation de zotero.org, ou plus tard.
 */
export interface ZoteroKeyAccess {
  /** Bibliothèque personnelle lisible. */
  userLibrary: boolean
  /** Tous les groupes lisibles (`groups.all.library`). */
  allGroups: boolean
  /** Groupes lisibles nommément. */
  groups: ReadonlySet<string>
}

export interface ZoteroKeyInfo {
  userId: string
  username: string | null
  access: ZoteroKeyAccess
}

/** La clé peut-elle lire cette bibliothèque (celle du compte `userId`, ou ce groupe) ? */
export function canReadLibrary(
  info: Pick<ZoteroKeyInfo, 'userId' | 'access'>,
  library: ZoteroLibraryRef,
): boolean {
  if (library.type === 'user') return library.id === info.userId && info.access.userLibrary
  return info.access.allGroups || info.access.groups.has(library.id)
}

/** Droits d'une réponse de `GET /keys/current` (absents : aucun). */
function keyAccessOf(value: unknown): ZoteroKeyAccess {
  const access = isRecord(value) ? value : {}
  const user = isRecord(access.user) ? access.user : {}
  const groups = isRecord(access.groups) ? access.groups : {}
  const readable = new Set<string>()
  let allGroups = false
  for (const [id, rights] of Object.entries(groups)) {
    if (!isRecord(rights) || rights.library !== true) continue
    if (id === 'all') allGroups = true
    else if (/^\d+$/.test(id)) readable.add(id)
  }
  return { userLibrary: user.library === true, allGroups, groups: readable }
}

/**
 * Clés de la collection `rootKey` et de toutes ses sous-collections (parcours de l'arbre, la
 * racine d'abord) ; vide si la collection n'est pas dans la liste.
 */
export function collectionSubtree(
  collections: readonly ZoteroCollectionInfo[],
  rootKey: string,
): string[] {
  if (!collections.some((collection) => collection.key === rootKey)) return []
  const children = new Map<string, string[]>()
  for (const collection of collections) {
    if (collection.parentKey === null) continue
    children.set(collection.parentKey, [
      ...(children.get(collection.parentKey) ?? []),
      collection.key,
    ])
  }
  const result: string[] = []
  const seen = new Set<string>()
  const queue = [rootKey]
  for (let key = queue.shift(); key !== undefined; key = queue.shift()) {
    if (seen.has(key)) continue
    seen.add(key)
    result.push(key)
    queue.push(...(children.get(key) ?? []))
  }
  return result
}

export interface ZoteroGroup {
  id: string
  name: string
}

export interface ZoteroCollectionInfo {
  key: string
  name: string
  parentKey: string | null
}

/** Élément d'une recherche : données JSON et entrée exportée (`include=data,<format>`). */
export interface ZoteroSearchHit {
  key: string
  /** Collections qui contiennent directement l'élément (`data.collections`). */
  collections: string[]
  itemType: string
  title: string
  creators: { lastName?: string; firstName?: string; name?: string; creatorType?: string }[]
  date: string
  /** Entrée BibTeX/BibLaTeX exportée, vide si Zotero n'en produit pas (note, pièce jointe). */
  exported: string
}

/**
 * Entrée BibTeX/BibLaTeX d'un élément, exportée seule (`include=<format>`) : sa clé de citation
 * ne dépend pas des autres éléments du lot (pas de suffixe a, b… ajouté par le traducteur).
 */
export interface ZoteroExportedItem {
  itemKey: string
  text: string
}

/** Élément nommé exporté seul, avec les collections qui le contiennent directement. */
export interface ZoteroExportedItemWithCollections extends ZoteroExportedItem {
  collections: string[]
}

/**
 * Export d'une bibliothèque : inchangée depuis `sinceVersion` (304), ou entrées de ses éléments.
 * `collectionScope` : la collection exportée et ses sous-collections (vide : toute la
 * bibliothèque).
 */
export type ZoteroExport =
  | { status: 'unchanged'; version: number | null }
  | {
      status: 'exported'
      version: number | null
      entries: ZoteroExportedItem[]
      items: number
      collectionScope: string[]
    }

export interface ZoteroClientOptions {
  fetch?: typeof fetch
  clientKey?: string | undefined
  clientSecret?: string | undefined
  oauthBaseUrl?: string
  apiBaseUrl?: string
  timeoutMs?: number
}

/** Taille d'une page de l'API (maximum accepté par Zotero). */
const PAGE_SIZE = 100
/** Clés d'éléments par requête `itemKey=` (maximum accepté par Zotero). */
const ITEM_KEYS_PER_REQUEST = 50
/** Pages lues au plus pour une liste (groupes, collections) : 5 000 entrées. */
const MAX_PAGES = 50

interface RawResponse {
  status: number
  headers: Headers
  text: string
}

/** Entier positif d'un en-tête (`Backoff`, `Retry-After`, `Total-Results`…), sinon null. */
function headerNumber(headers: Headers, name: string): number | null {
  const value = headers.get(name)
  if (value === null || !/^\d+$/.test(value.trim())) return null
  return Number(value.trim())
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stringOf(value: unknown): string {
  return typeof value === 'string' ? value : typeof value === 'number' ? String(value) : ''
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    throw new ZoteroHttpError(502, null)
  }
}

export default class ZoteroClient {
  readonly #fetch: typeof fetch
  readonly #clientKey: string | undefined
  readonly #clientSecret: string | undefined
  readonly #oauthBaseUrl: string
  readonly #apiBaseUrl: string
  readonly #timeoutMs: number

  constructor(options: ZoteroClientOptions = {}) {
    this.#fetch = options.fetch ?? globalThis.fetch
    const has = (key: keyof ZoteroClientOptions) => Object.hasOwn(options, key)
    this.#clientKey = has('clientKey') ? options.clientKey : zoteroConfig.clientKey
    this.#clientSecret = has('clientSecret')
      ? options.clientSecret
      : zoteroConfig.clientSecret?.release()
    this.#oauthBaseUrl = options.oauthBaseUrl ?? zoteroConfig.oauthBaseUrl
    this.#apiBaseUrl = options.apiBaseUrl ?? zoteroConfig.apiBaseUrl
    this.#timeoutMs = options.timeoutMs ?? zoteroConfig.requestTimeoutMs
  }

  /** L'application OAuth est configurée (clé et secret). */
  get configured(): boolean {
    return (this.#clientKey ?? '') !== '' && (this.#clientSecret ?? '') !== ''
  }

  /** Lève 503 `E_ZOTERO_UNAVAILABLE` si l'application OAuth n'est pas configurée. */
  assertConfigured(): void {
    if (!this.configured) throw new ZoteroUnavailableException()
  }

  private consumer(): { consumerKey: string; consumerSecret: string } {
    const consumerKey = this.#clientKey ?? ''
    const consumerSecret = this.#clientSecret ?? ''
    if (consumerKey === '' || consumerSecret === '') throw new ZoteroUnavailableException()
    return { consumerKey, consumerSecret }
  }

  private async send(url: URL, init: RequestInit): Promise<RawResponse> {
    let response: Response
    try {
      response = await this.#fetch(url, {
        ...init,
        redirect: 'error',
        signal: AbortSignal.timeout(this.#timeoutMs),
      })
    } catch (error) {
      logger.warn({ err: error, host: url.host, path: url.pathname }, 'zotero request failed')
      throw new ZoteroHttpError(0, null)
    }
    return { status: response.status, headers: response.headers, text: await response.text() }
  }

  // --- OAuth 1.0a -----------------------------------------------------------------------------

  /** Échange OAuth signé ; réponse `application/x-www-form-urlencoded`. */
  private async oauth(
    step: 'request' | 'access',
    options: { token?: string; tokenSecret?: string; extra: Record<string, string> },
  ): Promise<URLSearchParams> {
    const url = new URL(`${this.#oauthBaseUrl}/${step}`)
    const credentials = {
      ...this.consumer(),
      ...(options.token === undefined ? {} : { token: options.token }),
      ...(options.tokenSecret === undefined ? {} : { tokenSecret: options.tokenSecret }),
    }
    let response: RawResponse
    try {
      response = await this.send(url, {
        method: 'POST',
        headers: { authorization: authorizationHeader('POST', url, credentials, options) },
      })
    } catch {
      throw new ZoteroRequestFailedException()
    }
    if (response.status !== 200) {
      logger.warn({ step, status: response.status }, 'zotero oauth refused')
      throw new ZoteroOAuthFailedException()
    }
    return new URLSearchParams(response.text)
  }

  /** Jeton de requête OAuth, avec l'URL de rappel (`oauth_callback`). */
  async requestToken(callbackUrl: string): Promise<{ token: string; secret: string }> {
    const body = await this.oauth('request', { extra: { oauth_callback: callbackUrl } })
    const token = body.get('oauth_token') ?? ''
    const secret = body.get('oauth_token_secret') ?? ''
    if (token === '' || secret === '' || body.get('oauth_callback_confirmed') !== 'true') {
      throw new ZoteroOAuthFailedException()
    }
    return { token, secret }
  }

  /**
   * Page d'autorisation de zotero.org : accès en lecture seule à la bibliothèque personnelle
   * (sans les notes) et aux groupes, rien en écriture (permissions minimales).
   */
  authorizeUrl(token: string): string {
    const url = new URL(`${this.#oauthBaseUrl}/authorize`)
    url.search = new URLSearchParams({
      oauth_token: token,
      library_access: '1',
      notes_access: '0',
      write_access: '0',
      all_groups: 'read',
    }).toString()
    return url.toString()
  }

  /**
   * Échange le jeton de requête autorisé contre la clé d'API (`oauth_token_secret` de la
   * réponse, égal à `oauth_token` chez Zotero), avec le `userID` et le nom du compte.
   */
  async accessToken(
    token: string,
    tokenSecret: string,
    verifier: string,
  ): Promise<{ apiKey: string; userId: string; username: string | null }> {
    const body = await this.oauth('access', {
      token,
      tokenSecret,
      extra: { oauth_verifier: verifier },
    })
    const apiKey = body.get('oauth_token_secret') ?? body.get('oauth_token') ?? ''
    const userId = body.get('userID') ?? ''
    if (apiKey === '' || !/^\d+$/.test(userId)) throw new ZoteroOAuthFailedException()
    const username = body.get('username')
    return { apiKey, userId, username: username === null || username === '' ? null : username }
  }

  // --- API Web v3 ---------------------------------------------------------------------------

  /**
   * Requête à l'API : 2xx et 304 rendus à l'appelant, autre statut levé (`ZoteroHttpError`, avec
   * `Retry-After` ou `Backoff`).
   */
  private async api(
    method: 'GET' | 'DELETE',
    path: string,
    apiKey: string,
    options: { query?: Record<string, string>; headers?: Record<string, string> } = {},
  ): Promise<RawResponse> {
    const url = new URL(`${this.#apiBaseUrl}${path}`)
    if (options.query) url.search = new URLSearchParams(options.query).toString()
    const response = await this.send(url, {
      method,
      headers: {
        'zotero-api-version': '3',
        'zotero-api-key': apiKey,
        ...options.headers,
      },
    })
    if ((response.status >= 200 && response.status < 300) || response.status === 304) {
      return response
    }
    const retryAfter =
      headerNumber(response.headers, 'retry-after') ?? headerNumber(response.headers, 'backoff')
    logger.warn({ path: url.pathname, status: response.status }, 'zotero api error')
    throw new ZoteroHttpError(response.status, retryAfter)
  }

  /** Liste paginée (`start`, `limit`, en-tête `Total-Results`). */
  private async pages(
    path: string,
    apiKey: string,
    query: Record<string, string> = {},
    /** Appelé avec les en-têtes de chaque page (version, `Backoff`). */
    onPage?: (headers: Headers) => void,
  ): Promise<ZoteroResult<unknown[]>> {
    const all: unknown[] = []
    let backoffSeconds: number | null = null
    for (let page = 0; page < MAX_PAGES; page++) {
      const response = await this.api('GET', path, apiKey, {
        query: { ...query, limit: String(PAGE_SIZE), start: String(page * PAGE_SIZE) },
      })
      onPage?.(response.headers)
      backoffSeconds = headerNumber(response.headers, 'backoff') ?? backoffSeconds
      const value = parseJson(response.text)
      if (!Array.isArray(value)) throw new ZoteroHttpError(502, null)
      all.push(...(value as unknown[]))
      const total = headerNumber(response.headers, 'total-results')
      if (value.length < PAGE_SIZE || (total !== null && all.length >= total)) break
    }
    return { value: all, backoffSeconds }
  }

  /** Compte et droits de la clé (`GET /keys/current`) : vérifie qu'elle est valide. */
  async keyInfo(apiKey: string): Promise<ZoteroResult<ZoteroKeyInfo>> {
    const response = await this.api('GET', '/keys/current', apiKey)
    const body = parseJson(response.text)
    if (!isRecord(body)) throw new ZoteroHttpError(502, null)
    const userId = stringOf(body.userID)
    if (!/^\d+$/.test(userId)) throw new ZoteroHttpError(502, null)
    const username = stringOf(body.username)
    return {
      value: {
        userId,
        username: username === '' ? null : username,
        access: keyAccessOf(body.access),
      },
      backoffSeconds: headerNumber(response.headers, 'backoff'),
    }
  }

  /** Révoque la clé chez Zotero (`DELETE /keys/current`). */
  async deleteKey(apiKey: string): Promise<void> {
    await this.api('DELETE', '/keys/current', apiKey)
  }

  /** Groupes du compte. */
  async groups(userId: string, apiKey: string): Promise<ZoteroResult<ZoteroGroup[]>> {
    const { value, backoffSeconds } = await this.pages(`/users/${userId}/groups`, apiKey)
    return {
      value: value.flatMap((entry) => {
        if (!isRecord(entry)) return []
        const data = isRecord(entry.data) ? entry.data : {}
        const id = stringOf(entry.id) || stringOf(data.id)
        return /^\d+$/.test(id) ? [{ id, name: stringOf(data.name) || id }] : []
      }),
      backoffSeconds,
    }
  }

  /** Collections d'une bibliothèque (toutes, à plat, avec leur parent). */
  async collections(
    library: ZoteroLibraryRef,
    apiKey: string,
  ): Promise<ZoteroResult<ZoteroCollectionInfo[]>> {
    const { value, backoffSeconds } = await this.pages(
      `${libraryPath(library)}/collections`,
      apiKey,
    )
    return { value: value.flatMap(collectionOf), backoffSeconds }
  }

  /** Une collection (404 levé si elle n'existe pas ou n'est pas lisible). */
  async collection(
    library: ZoteroLibraryRef,
    key: string,
    apiKey: string,
  ): Promise<ZoteroResult<ZoteroCollectionInfo>> {
    const response = await this.api('GET', `${libraryPath(library)}/collections/${key}`, apiKey)
    const [collection] = collectionOf(parseJson(response.text))
    if (!collection) throw new ZoteroHttpError(502, null)
    return { value: collection, backoffSeconds: headerNumber(response.headers, 'backoff') }
  }

  /**
   * Export des éléments de premier niveau d'une bibliothèque, ou d'une collection et de toutes
   * ses sous-collections (comme « Exporter la collection… » de Zotero), page par page : réponse
   * JSON avec l'entrée de chaque élément (`include=<format>`), exportée élément par élément (un
   * élément présent dans plusieurs collections revient plusieurs fois : la synchro dédoublonne
   * par clé d'élément). `sinceVersion` : en-tête `If-Modified-Since-Version` sur la première
   * requête (304 si la bibliothèque n'a pas changé, sous-collections comprises). Si la
   * bibliothèque change pendant l'export (`Last-Modified-Version` différent d'une requête à
   * l'autre), l'export recommence (deux fois au plus) : le texte rendu est cohérent.
   */
  async exportLibrary(
    library: ZoteroLibraryRef,
    apiKey: string,
    options: {
      collectionKey: string | null
      format: ZoteroExportFormat
      sinceVersion: number | null
      maxItems: number
      /** Sous-collections exportées au plus (au-delà : `ZoteroExportTooLargeError`). */
      maxCollections: number
    },
  ): Promise<ZoteroResult<ZoteroExport>> {
    const base = libraryPath(library)
    const itemsPath = (key: string | null) =>
      key === null ? `${base}/items/top` : `${base}/collections/${key}/items/top`
    let backoffSeconds: number | null = null
    for (let attempt = 0; attempt < 3; attempt++) {
      const entries: ZoteroExportedItem[] = []
      const distinct = new Set<string>()
      // Version de la première réponse ; toutes les suivantes doivent avoir la même.
      const pass: { version: number | null; first: boolean; consistent: boolean } = {
        version: null,
        first: true,
        consistent: true,
      }
      const track = (headers: Headers) => {
        backoffSeconds = headerNumber(headers, 'backoff') ?? backoffSeconds
        const pageVersion = headerNumber(headers, 'last-modified-version')
        if (pass.first) pass.version = pageVersion
        else if (pageVersion !== pass.version) pass.consistent = false
        pass.first = false
      }
      // Lu par une fonction : l'état change pendant les appels (`track`).
      const consistent = () => pass.consistent
      const exportPath = async (path: string): Promise<'unchanged' | 'done'> => {
        for (let start = 0; consistent(); start += PAGE_SIZE) {
          const response = await this.api('GET', path, apiKey, {
            query: { include: options.format, limit: String(PAGE_SIZE), start: String(start) },
            headers:
              pass.first && options.sinceVersion !== null
                ? { 'if-modified-since-version': String(options.sinceVersion) }
                : {},
          })
          if (response.status === 304) {
            pass.version = headerNumber(response.headers, 'last-modified-version')
            backoffSeconds = headerNumber(response.headers, 'backoff') ?? backoffSeconds
            return 'unchanged'
          }
          track(response.headers)
          if (!consistent()) break
          const total = headerNumber(response.headers, 'total-results')
          if (total !== null && total > options.maxItems) throw new ZoteroExportTooLargeError()
          for (const entry of exportedItemsOf(response.text, options.format)) {
            entries.push(entry)
            distinct.add(entry.itemKey)
          }
          if (distinct.size > options.maxItems) throw new ZoteroExportTooLargeError()
          if (total === null || start + PAGE_SIZE >= total) break
        }
        return 'done'
      }

      if ((await exportPath(itemsPath(options.collectionKey))) === 'unchanged') {
        return { value: { status: 'unchanged', version: pass.version }, backoffSeconds }
      }
      let collectionScope: string[] = []
      if (options.collectionKey !== null && consistent()) {
        // Sous-collections : arbre lu à la même version que les éléments.
        const listed = await this.pages(`${base}/collections`, apiKey, {}, track)
        collectionScope = collectionSubtree(
          listed.value.flatMap(collectionOf),
          options.collectionKey,
        )
        if (collectionScope.length === 0) throw new ZoteroHttpError(404, null)
        if (collectionScope.length - 1 > options.maxCollections) {
          throw new ZoteroExportTooLargeError()
        }
        for (const key of collectionScope.slice(1)) {
          if (!consistent()) break
          await exportPath(itemsPath(key))
        }
      }
      if (consistent()) {
        return {
          value: {
            status: 'exported',
            version: pass.version,
            entries,
            items: distinct.size,
            collectionScope,
          },
          backoffSeconds,
        }
      }
    }
    throw new ZoteroHttpError(409, null)
  }

  /**
   * Export d'éléments nommés (`itemKey=`), par lots de 50, chacun exporté seul, avec les
   * collections qui les contiennent (`include=data,<format>`).
   */
  async exportItems(
    library: ZoteroLibraryRef,
    apiKey: string,
    keys: readonly string[],
    format: ZoteroExportFormat,
  ): Promise<ZoteroResult<ZoteroExportedItemWithCollections[]>> {
    const entries: ZoteroExportedItemWithCollections[] = []
    let backoffSeconds: number | null = null
    for (let index = 0; index < keys.length; index += ITEM_KEYS_PER_REQUEST) {
      const response = await this.api('GET', `${libraryPath(library)}/items`, apiKey, {
        query: {
          itemKey: keys.slice(index, index + ITEM_KEYS_PER_REQUEST).join(','),
          include: `data,${format}`,
        },
      })
      backoffSeconds = headerNumber(response.headers, 'backoff') ?? backoffSeconds
      entries.push(...exportedItemsOf(response.text, format))
    }
    return { value: entries, backoffSeconds }
  }

  /**
   * Recherche rapide (titre, auteurs, année : `qmode=titleCreatorYear`) dans les éléments de
   * premier niveau, avec leurs données et leur entrée exportée.
   */
  async search(
    library: ZoteroLibraryRef,
    apiKey: string,
    query: string,
    options: { limit: number; format: ZoteroExportFormat },
  ): Promise<ZoteroResult<ZoteroSearchHit[]>> {
    const response = await this.api('GET', `${libraryPath(library)}/items/top`, apiKey, {
      query: {
        q: query,
        qmode: 'titleCreatorYear',
        limit: String(options.limit),
        include: `data,${options.format}`,
        sort: 'dateModified',
        direction: 'desc',
      },
    })
    const value = parseJson(response.text)
    if (!Array.isArray(value)) throw new ZoteroHttpError(502, null)
    return {
      value: (value as unknown[]).flatMap((entry): ZoteroSearchHit[] => {
        if (!isRecord(entry) || !isRecord(entry.data)) return []
        const data = entry.data
        const key = stringOf(entry.key)
        if (key === '') return []
        const creators = Array.isArray(data.creators)
          ? (data.creators as unknown[]).filter(isRecord).map((creator) => ({
              lastName: stringOf(creator.lastName),
              firstName: stringOf(creator.firstName),
              name: stringOf(creator.name),
              creatorType: stringOf(creator.creatorType),
            }))
          : []
        return [
          {
            key,
            collections: collectionKeysOf(data),
            itemType: stringOf(data.itemType),
            title: stringOf(data.title),
            creators,
            date: stringOf(data.date),
            exported: stringOf(entry[options.format]),
          },
        ]
      }),
      backoffSeconds: headerNumber(response.headers, 'backoff'),
    }
  }
}

/** Export plus grand que la limite d'éléments d'une synchronisation. */
export class ZoteroExportTooLargeError extends Error {
  constructor() {
    super('Zotero export is too large')
    this.name = 'ZoteroExportTooLargeError'
  }
}

/** Collections d'un élément (`data.collections`), vide si la réponse ne les donne pas. */
function collectionKeysOf(data: unknown): string[] {
  if (!isRecord(data) || !Array.isArray(data.collections)) return []
  return (data.collections as unknown[]).filter(
    (key): key is string => typeof key === 'string' && key !== '',
  )
}

/**
 * Entrées exportées d'une réponse JSON (`include=<format>`, avec `data` si demandé) ; un élément
 * sans entrée est omis.
 */
function exportedItemsOf(
  text: string,
  format: ZoteroExportFormat,
): ZoteroExportedItemWithCollections[] {
  const value = parseJson(text)
  if (!Array.isArray(value)) throw new ZoteroHttpError(502, null)
  return (value as unknown[]).flatMap((entry) => {
    if (!isRecord(entry)) return []
    const itemKey = stringOf(entry.key)
    const exported = stringOf(entry[format]).trim()
    return itemKey === '' || exported === ''
      ? []
      : [{ itemKey, text: exported, collections: collectionKeysOf(entry.data) }]
  })
}

function collectionOf(entry: unknown): ZoteroCollectionInfo[] {
  if (!isRecord(entry) || !isRecord(entry.data)) return []
  const key = stringOf(entry.key)
  if (key === '') return []
  const parent = entry.data.parentCollection
  return [
    {
      key,
      name: stringOf(entry.data.name) || key,
      parentKey: typeof parent === 'string' && parent !== '' ? parent : null,
    },
  ]
}
