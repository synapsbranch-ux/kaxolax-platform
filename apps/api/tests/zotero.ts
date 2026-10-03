import ZoteroClient from '#services/zotero/client'
import { hmacSha1Signature, signatureBaseString } from '#services/zotero/oauth1'

/**
 * Faux Zotero pour les tests : points d'accès OAuth 1.0a (signatures vérifiées), et ce que la
 * synchronisation utilise de l'API Web v3 (clés, groupes, collections, export, recherche,
 * versions, `Backoff`, `Retry-After`). Le vrai `ZoteroClient` lui parle par un `fetch` injecté :
 * aucun appel réseau.
 */

export const FAKE_CONSUMER = { key: 'test-client-key', secret: 'test-client-secret' }
export const FAKE_ZOTERO_USER = { id: '1234567', username: 'ada' }
export const FAKE_GROUP = { id: '4242', name: 'Analytical Engine Lab' }

export interface FakeItem {
  key: string
  citationKey: string
  title: string
  creators: { lastName: string; firstName: string }[]
  date: string
  /** Collections qui contiennent l'élément. */
  collections: string[]
  /** Bibliothèque : `user` (celle de FAKE_ZOTERO_USER) ou `group` (FAKE_GROUP). */
  library: 'user' | 'group'
}

export interface FakeRequest {
  method: string
  url: URL
  headers: Headers
}

/** Réponse forcée pour la prochaine requête dont le chemin contient `pathIncludes`. */
interface Override {
  pathIncludes: string
  status: number
  headers: Record<string, string>
  body?: string
  /** Laisse passer la réponse normale en lui ajoutant `headers`. */
  passThrough?: boolean
}

function parseOAuthHeader(header: string | null): Record<string, string> {
  if (header?.startsWith('OAuth ') !== true) return {}
  return Object.fromEntries(
    [...header.matchAll(/([a-z_]+)="([^"]*)"/g)].map((match) => [
      match[1] ?? '',
      decodeURIComponent(match[2] ?? ''),
    ]),
  )
}

export function bibEntryOf(item: FakeItem): string {
  const authors = item.creators
    .map((creator) => `${creator.lastName}, ${creator.firstName}`)
    .join(' and ')
  return `@article{${item.citationKey},\n\ttitle = {${item.title}},\n\tauthor = {${authors}},\n\tdate = {${item.date}},\n}`
}

export class FakeZotero {
  requests: FakeRequest[] = []
  libraryVersion = 10
  items: FakeItem[] = [
    {
      key: 'AAAA2222',
      citationKey: 'lovelace_notes_1843',
      title: 'Notes on the Analytical Engine',
      creators: [{ lastName: 'Lovelace', firstName: 'Ada' }],
      date: '1843',
      collections: ['THES2345'],
      library: 'user',
    },
    {
      key: 'BBBB3333',
      citationKey: 'babbage_passages_1864',
      title: 'Passages from the Life of a Philosopher',
      creators: [{ lastName: 'Babbage', firstName: 'Charles' }],
      date: '1864-01-01',
      collections: [],
      library: 'user',
    },
    {
      key: 'CCCC4444',
      citationKey: 'menabrea_sketch_1842',
      title: 'Sketch of the Analytical Engine',
      creators: [
        { lastName: 'Menabrea', firstName: 'Luigi' },
        { lastName: 'Lovelace', firstName: 'Ada' },
      ],
      date: '1842',
      collections: ['GRUP2345'],
      library: 'group',
    },
  ]
  collections: { key: string; name: string; library: 'user' | 'group'; parentKey?: string }[] = [
    { key: 'THES2345', name: 'Thesis', library: 'user' },
    { key: 'GRUP2345', name: 'Lab papers', library: 'group' },
  ]
  /**
   * Droits accordés aux clés sur la page d'autorisation (objet `access` de `/keys/current`) :
   * l'API Web refuse (403) une bibliothèque non lisible.
   */
  access: { user: boolean; groups: 'all' | string[] } = { user: true, groups: 'all' }
  /** Clés d'API valides (émises par l'OAuth ou ajoutées par le test). */
  validKeys = new Set<string>()
  revokedKeys: string[] = []
  /**
   * Appelé (une fois) avant de répondre à la prochaine requête de l'API Web dont le chemin
   * contient `pathIncludes` : simule ce qui se passe pendant un appel à Zotero.
   */
  private pauses: { pathIncludes: string; run: () => Promise<void> }[] = []
  private requestTokens = new Map<string, { secret: string; verifier: string | null }>()
  private overrides: Override[] = []
  private issued = 0

  /** Client branché sur ce faux Zotero (application OAuth configurée par défaut). */
  client(configured = true): ZoteroClient {
    return new ZoteroClient({
      fetch: (input, init) => this.fetch(input, init),
      clientKey: configured ? FAKE_CONSUMER.key : undefined,
      clientSecret: configured ? FAKE_CONSUMER.secret : undefined,
      oauthBaseUrl: 'https://zotero.test/oauth',
      apiBaseUrl: 'https://api.zotero.test',
    })
  }

  /** Simule l'accord de l'utilisateur sur zotero.org : renvoie le `oauth_verifier`. */
  authorize(requestToken: string): string {
    const pending = this.requestTokens.get(requestToken)
    if (!pending) throw new Error(`unknown request token ${requestToken}`)
    pending.verifier = `verifier-${requestToken}`
    return pending.verifier
  }

  /** Prochaine requête dont le chemin contient `pathIncludes` : cette réponse. */
  respondOnce(pathIncludes: string, status: number, headers: Record<string, string> = {}) {
    this.overrides.push({ pathIncludes, status, headers })
  }

  /** Prochaine requête dont le chemin contient `pathIncludes` : réponse normale + en-têtes. */
  addHeadersOnce(pathIncludes: string, headers: Record<string, string>) {
    this.overrides.push({ pathIncludes, status: 200, headers, passThrough: true })
  }

  /** Pendant la prochaine requête dont le chemin contient `pathIncludes` : exécute `run`. */
  duringNext(pathIncludes: string, run: () => Promise<void>) {
    this.pauses.push({ pathIncludes, run })
  }

  /** Requêtes vers l'API Web (hors OAuth) dont le chemin contient `fragment`. */
  apiCalls(fragment: string): FakeRequest[] {
    return this.requests.filter(
      (request) =>
        request.url.host === 'api.zotero.test' && request.url.pathname.includes(fragment),
    )
  }

  async fetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
    const url = new URL(input instanceof Request ? input.url : input.toString())
    const method = (init?.method ?? 'GET').toUpperCase()
    const headers = new Headers(init?.headers)
    this.requests.push({ method, url, headers })
    const pause = this.pauses.findIndex((entry) => url.pathname.includes(entry.pathIncludes))
    if (pause !== -1) await this.pauses.splice(pause, 1)[0]?.run()
    const index = this.overrides.findIndex((entry) => url.pathname.includes(entry.pathIncludes))
    const override = index === -1 ? undefined : this.overrides.splice(index, 1)[0]
    if (override && !override.passThrough) {
      return Promise.resolve(new Response(override.body ?? null, override))
    }
    const response =
      url.host === 'zotero.test' ? this.oauth(method, url, headers) : this.api(method, url, headers)
    if (override?.passThrough) {
      for (const [name, value] of Object.entries(override.headers)) {
        response.headers.set(name, value)
      }
    }
    return Promise.resolve(response)
  }

  /** Vérifie la signature HMAC-SHA1 d'un échange OAuth. */
  private checkSignature(
    method: string,
    url: URL,
    oauth: Record<string, string>,
    tokenSecret: string,
  ): boolean {
    const { oauth_signature: signature, ...signed } = oauth
    const base = signatureBaseString(method, url, Object.entries(signed))
    return (
      signed.oauth_consumer_key === FAKE_CONSUMER.key &&
      signed.oauth_signature_method === 'HMAC-SHA1' &&
      signature === hmacSha1Signature(base, FAKE_CONSUMER.secret, tokenSecret)
    )
  }

  private oauth(method: string, url: URL, headers: Headers): Response {
    const oauth = parseOAuthHeader(headers.get('authorization'))
    const form = (values: Record<string, string>) =>
      new Response(new URLSearchParams(values).toString(), {
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
      })
    if (url.pathname === '/oauth/request') {
      if (!this.checkSignature(method, url, oauth, '') || !oauth.oauth_callback) {
        return new Response('invalid signature', { status: 401 })
      }
      this.issued++
      const token = `request-token-${String(this.issued)}`
      this.requestTokens.set(token, {
        secret: `request-secret-${String(this.issued)}`,
        verifier: null,
      })
      return form({
        oauth_token: token,
        oauth_token_secret: `request-secret-${String(this.issued)}`,
        oauth_callback_confirmed: 'true',
      })
    }
    if (url.pathname === '/oauth/access') {
      const token = oauth.oauth_token ?? ''
      const pending = this.requestTokens.get(token)
      if (
        !pending ||
        !this.checkSignature(method, url, oauth, pending.secret) ||
        pending.verifier === null ||
        oauth.oauth_verifier !== pending.verifier
      ) {
        return new Response('invalid', { status: 401 })
      }
      this.requestTokens.delete(token)
      this.issued++
      const key = `apikey${String(this.issued)}xxxxxxxxxxxx`
      this.validKeys.add(key)
      return form({
        oauth_token: key,
        oauth_token_secret: key,
        userID: FAKE_ZOTERO_USER.id,
        username: FAKE_ZOTERO_USER.username,
      })
    }
    return new Response('not found', { status: 404 })
  }

  private libraryItems(type: 'users' | 'groups', id: string): FakeItem[] | null {
    if (type === 'users' && id === FAKE_ZOTERO_USER.id) {
      return this.items.filter((item) => item.library === 'user')
    }
    if (type === 'groups' && id === FAKE_GROUP.id) {
      return this.items.filter((item) => item.library === 'group')
    }
    return null
  }

  private api(method: string, url: URL, headers: Headers): Response {
    if (headers.get('zotero-api-version') !== '3') return new Response('version', { status: 400 })
    const key = headers.get('zotero-api-key') ?? ''
    if (!this.validKeys.has(key)) return new Response('Forbidden', { status: 403 })
    const json = (value: unknown, extra: Record<string, string> = {}) =>
      new Response(JSON.stringify(value), {
        headers: { 'content-type': 'application/json', ...extra },
      })
    const versionHeaders = { 'last-modified-version': String(this.libraryVersion) }
    const path = url.pathname

    if (path === '/keys/current') {
      if (method === 'DELETE') {
        this.validKeys.delete(key)
        this.revokedKeys.push(key)
        return new Response(null, { status: 204 })
      }
      const groups =
        this.access.groups === 'all'
          ? { all: { library: true, write: false } }
          : Object.fromEntries(
              this.access.groups.map((id) => [id, { library: true, write: false }]),
            )
      return json({
        key,
        userID: Number(FAKE_ZOTERO_USER.id),
        username: FAKE_ZOTERO_USER.username,
        access: {
          ...(this.access.user ? { user: { library: true, notes: false, write: false } } : {}),
          groups,
        },
      })
    }
    if (path === `/users/${FAKE_ZOTERO_USER.id}/groups`) {
      return json(
        [{ id: Number(FAKE_GROUP.id), data: { id: Number(FAKE_GROUP.id), name: FAKE_GROUP.name } }],
        {
          'total-results': '1',
        },
      )
    }
    const match = /^\/(users|groups)\/(\d+)(\/.*)$/.exec(path)
    if (!match?.[1] || !match[2] || !match[3]) return new Response('not found', { status: 404 })
    const type = match[1] as 'users' | 'groups'
    const items = this.libraryItems(type, match[2])
    if (items === null) return new Response('not found', { status: 404 })
    const readable =
      type === 'users'
        ? this.access.user
        : this.access.groups === 'all' || this.access.groups.includes(match[2])
    if (!readable) return new Response('Forbidden', { status: 403 })
    const libraryCollections = this.collections.filter(
      (collection) => collection.library === (type === 'users' ? 'user' : 'group'),
    )
    const rest = match[3]
    const toJson = (collection: { key: string; name: string; parentKey?: string }) => ({
      key: collection.key,
      data: {
        key: collection.key,
        name: collection.name,
        parentCollection: collection.parentKey ?? false,
      },
    })
    if (rest === '/collections') {
      return json(libraryCollections.map(toJson), {
        'total-results': String(libraryCollections.length),
        'last-modified-version': String(this.libraryVersion),
      })
    }
    const collectionMatch = /^\/collections\/([A-Z0-9]{8})(\/items\/top)?$/.exec(rest)
    if (collectionMatch?.[1]) {
      const collection = libraryCollections.find((entry) => entry.key === collectionMatch[1])
      if (!collection) return new Response('not found', { status: 404 })
      if (!collectionMatch[2]) return json(toJson(collection))
      return this.export(
        items.filter((item) => item.collections.includes(collection.key)),
        url,
        headers,
      )
    }
    if (rest === '/items/top') {
      const query = url.searchParams.get('q')
      if (query !== null) {
        const needle = query.toLowerCase()
        const found = items.filter(
          (item) =>
            item.title.toLowerCase().includes(needle) ||
            item.creators.some((creator) => creator.lastName.toLowerCase().includes(needle)) ||
            item.date.includes(needle),
        )
        const format = url.searchParams.get('include')?.split(',')[1] ?? 'biblatex'
        return json(
          found.map((item) => ({
            ...this.exported(item, format),
            data: {
              key: item.key,
              itemType: 'journalArticle',
              title: item.title,
              creators: item.creators.map((creator) => ({ creatorType: 'author', ...creator })),
              date: item.date,
              collections: item.collections,
            },
          })),
          versionHeaders,
        )
      }
      return this.export(items, url, headers)
    }
    if (rest === '/items') {
      const keys = (url.searchParams.get('itemKey') ?? '').split(',')
      const include = (url.searchParams.get('include') ?? '').split(',')
      const format = include.at(-1) ?? ''
      if (!['biblatex', 'bibtex'].includes(format)) return new Response('format', { status: 400 })
      return json(
        items
          .filter((item) => keys.includes(item.key))
          .map((item) => ({
            ...this.exported(item, format),
            ...(include.includes('data')
              ? { data: { key: item.key, collections: item.collections } }
              : {}),
          })),
        versionHeaders,
      )
    }
    return new Response('not found', { status: 404 })
  }

  /** Élément exporté seul (`include=<format>`) : clé, version et entrée. */
  private exported(item: FakeItem, format: string) {
    return { key: item.key, version: this.libraryVersion, [format]: `\n${bibEntryOf(item)}\n` }
  }

  /** Export paginé (`include=<format>`, `start`, `limit`), versions et 304. */
  private export(items: FakeItem[], url: URL, headers: Headers): Response {
    const versionHeaders = {
      'content-type': 'application/json',
      'last-modified-version': String(this.libraryVersion),
      'total-results': String(items.length),
    }
    const since = headers.get('if-modified-since-version')
    if (since !== null && Number(since) >= this.libraryVersion) {
      return new Response(null, { status: 304, headers: versionHeaders })
    }
    const format = url.searchParams.get('include') ?? ''
    if (!['biblatex', 'bibtex'].includes(format)) return new Response('format', { status: 400 })
    const start = Number(url.searchParams.get('start') ?? '0')
    const limit = Number(url.searchParams.get('limit') ?? '25')
    return new Response(
      JSON.stringify(items.slice(start, start + limit).map((item) => this.exported(item, format))),
      { headers: versionHeaders },
    )
  }
}
