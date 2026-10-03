import { createHmac, randomBytes } from 'node:crypto'

/**
 * Signature OAuth 1.0a HMAC-SHA1 (RFC 5849, section 3.4), suffisante pour les trois appels OAuth
 * de Zotero (jeton de requête, jeton d'accès) : pas de dépendance OAuth. Vérifiée par les vecteurs
 * connus de la RFC 5849 et de la documentation de Twitter (tests/unit/zotero_oauth1.spec.ts).
 */

/** Identifiants de l'application (« client ») et jeton éventuel avec son secret. */
export interface OAuth1Credentials {
  consumerKey: string
  consumerSecret: string
  token?: string
  tokenSecret?: string
}

/** Paramètres variables d'une signature (fixés dans les tests, aléatoires sinon). */
export interface OAuth1Nonce {
  nonce: string
  /** Secondes depuis l'époque Unix. */
  timestamp: number
}

/**
 * Encodage « percent » de la RFC 5849 (section 3.6) : tout sauf `A-Z a-z 0-9 - . _ ~`, en
 * majuscules. `encodeURIComponent` laisse passer `! * ' ( )`, encodés ici.
 */
export function percentEncode(value: string): string {
  return encodeURIComponent(value).replace(
    /[!*'()]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  )
}

/**
 * URI de base (section 3.4.1.2) : schéma et hôte en minuscules, port par défaut retiré, sans
 * requête ni fragment.
 */
export function baseStringUri(url: URL): string {
  const defaultPort =
    (url.protocol === 'https:' && url.port === '443') ||
    (url.protocol === 'http:' && url.port === '80')
  const port = url.port === '' || defaultPort ? '' : `:${url.port}`
  return `${url.protocol.toLowerCase()}//${url.hostname.toLowerCase()}${port}${url.pathname}`
}

/**
 * Chaîne de base de la signature (section 3.4.1) : méthode, URI de base, puis paramètres (requête,
 * corps `application/x-www-form-urlencoded`, paramètres `oauth_*` sans `oauth_signature`)
 * encodés, triés par nom puis par valeur et joints.
 */
export function signatureBaseString(
  method: string,
  url: URL,
  parameters: readonly (readonly [string, string])[],
): string {
  const encoded = [...url.searchParams.entries(), ...parameters]
    .map(([name, value]) => [percentEncode(name), percentEncode(value)] as const)
    .sort(([a, x], [b, y]) => (a === b ? compare(x, y) : compare(a, b)))
    .map(([name, value]) => `${name}=${value}`)
    .join('&')
  return [method.toUpperCase(), percentEncode(baseStringUri(url)), percentEncode(encoded)].join('&')
}

/** Ordre des octets (les chaînes encodées sont en ASCII). */
function compare(a: string, b: string): number {
  if (a === b) return 0
  return a < b ? -1 : 1
}

/** Signature HMAC-SHA1 en base64 (section 3.4.2) : clé `secret_client&secret_jeton`. */
export function hmacSha1Signature(
  baseString: string,
  consumerSecret: string,
  tokenSecret = '',
): string {
  const key = `${percentEncode(consumerSecret)}&${percentEncode(tokenSecret)}`
  return createHmac('sha1', key).update(baseString).digest('base64')
}

export function randomNonce(): OAuth1Nonce {
  return {
    nonce: randomBytes(16).toString('hex'),
    timestamp: Math.floor(Date.now() / 1000),
  }
}

/**
 * En-tête `Authorization: OAuth …` signé d'une requête. `extra` : paramètres `oauth_*`
 * supplémentaires (`oauth_callback`, `oauth_verifier`) ; `body` : paramètres d'un corps
 * `application/x-www-form-urlencoded`, inclus dans la signature.
 */
export function authorizationHeader(
  method: string,
  url: URL,
  credentials: OAuth1Credentials,
  options: {
    extra?: Readonly<Record<string, string>>
    body?: readonly (readonly [string, string])[]
    nonce?: OAuth1Nonce
  } = {},
): string {
  const { nonce, timestamp } = options.nonce ?? randomNonce()
  const oauth: Record<string, string> = {
    oauth_consumer_key: credentials.consumerKey,
    oauth_nonce: nonce,
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: String(timestamp),
    oauth_version: '1.0',
    ...(credentials.token === undefined ? {} : { oauth_token: credentials.token }),
    ...options.extra,
  }
  const base = signatureBaseString(method, url, [...Object.entries(oauth), ...(options.body ?? [])])
  oauth.oauth_signature = hmacSha1Signature(
    base,
    credentials.consumerSecret,
    credentials.tokenSecret,
  )
  return `OAuth ${Object.entries(oauth)
    .map(([name, value]) => `${percentEncode(name)}="${percentEncode(value)}"`)
    .join(', ')}`
}
