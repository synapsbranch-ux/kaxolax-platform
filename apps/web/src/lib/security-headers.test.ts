import { type NextFetchEvent, NextRequest } from 'next/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  originOf,
  WEB_PERMISSIONS_POLICY,
  WEB_SECURITY_HEADERS,
  webCspDirectives,
} from './security-headers'

/** Directives d'un en-tête CSP, par nom. */
function parseCsp(header: string): Map<string, string[]> {
  return new Map(
    header
      .split(';')
      .map((part) => part.trim().split(/\s+/))
      .filter((tokens) => tokens[0] !== undefined && tokens[0] !== '')
      .map(([name = '', ...values]) => [name, values]),
  )
}

const FAPI = 'clerk.kaxolax.test'

/** Proxy de l'application chargé avec cet environnement (modules relus à chaque appel). */
async function proxyResponse(env: Record<string, string>, path = '/dashboard') {
  vi.resetModules()
  // Environnement propre à chaque appel : rien ne reste d'un appel précédent du même test.
  vi.unstubAllEnvs()
  for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value)
  vi.stubEnv('CLERK_PUBLISHABLE_KEY', `pk_live_${Buffer.from(`${FAPI}$`).toString('base64')}`)
  vi.stubEnv('CLERK_SECRET_KEY', 'sk_live_test_secret_key_not_used_without_session')
  const { default: proxy } = await import('@/proxy')
  const request = new NextRequest(`https://app.kaxolax.test${path}`, {
    headers: { accept: 'text/html' },
  })
  const response = await proxy(request, {} as NextFetchEvent)
  if (!response) throw new Error('no response from the proxy')
  return response
}

/** API vue par le proxy (`GET /api/v1/client-config`) : injoignable sauf mention contraire. */
const apiFetch = vi.fn<typeof fetch>()

describe('security headers', () => {
  beforeEach(() => {
    apiFetch.mockReset()
    apiFetch.mockRejectedValue(new Error('ECONNREFUSED'))
    vi.stubGlobal('fetch', apiFetch)
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('reads origins from the configuration and ignores invalid values', () => {
    expect(originOf('wss://realtime.kaxolax.com/socket')).toBe('wss://realtime.kaxolax.com')
    expect(originOf('http://localhost:8333')).toBe('http://localhost:8333')
    expect(originOf('')).toBeNull()
    expect(originOf(undefined)).toBeNull()
    expect(originOf('not a url')).toBeNull()
  })

  it('allows the realtime service, the storage and the templates, nothing else', () => {
    const directives = webCspDirectives({
      realtimeUrl: 'wss://realtime.kaxolax.com',
      storageUrl: 'https://account.eu.r2.cloudflarestorage.com',
      templateUrls: ['https://templates.kaxolax.com/files/', undefined, 'bad'],
    })
    expect(directives['connect-src']).toEqual([
      "'self'",
      'wss://realtime.kaxolax.com',
      'https://account.eu.r2.cloudflarestorage.com',
      'https://*.account.eu.r2.cloudflarestorage.com',
      'https://templates.kaxolax.com',
    ])
    expect(directives['img-src']).toContain('https://templates.kaxolax.com')
    expect(directives['frame-ancestors']).toEqual(["'none'"])
    expect(directives['object-src']).toEqual(["'none'"])
    // Jamais d'eval JavaScript : WebAssembly seulement.
    expect(directives['script-src']).toEqual(["'wasm-unsafe-eval'"])
    // Un stockage local (http) n'ouvre pas de sous-domaines.
    expect(webCspDirectives({ storageUrl: 'http://localhost:8333' })['img-src']).toEqual([
      "'self'",
      'data:',
      'blob:',
      'http://localhost:8333',
    ])
  })

  it('sets fixed headers on every response', () => {
    expect(WEB_SECURITY_HEADERS).toEqual(
      expect.arrayContaining([
        { key: 'X-Content-Type-Options', value: 'nosniff' },
        { key: 'X-Frame-Options', value: 'DENY' },
        { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
      ]),
    )
    expect(WEB_PERMISSIONS_POLICY).toContain('camera=()')
    expect(WEB_PERMISSIONS_POLICY).toContain('payment=(self "https://js.stripe.com")')
  })

  it('gives every page a strict policy with a fresh nonce, shared with Next.js', async () => {
    const response = await proxyResponse({
      NODE_ENV: 'production',
      REALTIME_PUBLIC_URL: 'wss://realtime.kaxolax.test',
      S3_PUBLIC_ENDPOINT: 'https://storage.kaxolax.test',
      TEMPLATES_PUBLIC_URL: 'https://templates.kaxolax.test/files/',
    })
    const header = response.headers.get('content-security-policy') ?? ''
    const csp = parseCsp(header)
    const nonce = response.headers.get('x-nonce') ?? ''
    expect(nonce).not.toBe('')
    expect(csp.get('script-src')).toEqual(
      expect.arrayContaining(["'strict-dynamic'", `'nonce-${nonce}'`, "'wasm-unsafe-eval'"]),
    )
    // En production, aucune exception à l'eval JavaScript.
    expect(csp.get('script-src')).not.toContain("'unsafe-eval'")
    expect(csp.get('connect-src')).toEqual(
      expect.arrayContaining([
        "'self'",
        FAPI,
        'wss://realtime.kaxolax.test',
        'https://storage.kaxolax.test',
        'https://templates.kaxolax.test',
      ]),
    )
    expect(csp.get('img-src')).toEqual(expect.arrayContaining(['https://img.clerk.com', 'data:']))
    expect(csp.get('frame-src')).toEqual(
      expect.arrayContaining(['https://challenges.cloudflare.com', 'blob:']),
    )
    expect(csp.get('frame-ancestors')).toEqual(["'none'"])
    expect(csp.get('object-src')).toEqual(["'none'"])
    expect(csp.get('base-uri')).toEqual(["'self'"])
    // Même politique transmise à Next.js (nonce de ses scripts) par les en-têtes de la requête.
    expect(response.headers.get('x-middleware-request-content-security-policy')).toBe(header)
    expect(response.headers.get('x-middleware-request-x-nonce')).toBe(nonce)

    // Les variables suffisent : l'API n'est pas consultée.
    expect(apiFetch).not.toHaveBeenCalled()

    // Production sans origines et API injoignable : la page est servie, jamais avec la pile
    // locale dans la politique.
    const next = await proxyResponse({ NODE_ENV: 'production' })
    expect(next.headers.get('x-nonce')).not.toBe(nonce)
    expect(next.headers.get('content-security-policy')).not.toContain('localhost')

    // Stockage : repli sur S3_ENDPOINT, comme l'API.
    const fallback = await proxyResponse({
      NODE_ENV: 'production',
      REALTIME_PUBLIC_URL: 'wss://realtime.kaxolax.test',
      S3_ENDPOINT: 'https://r2.kaxolax.test',
    })
    expect(
      parseCsp(fallback.headers.get('content-security-policy') ?? '').get('connect-src'),
    ).toEqual(expect.arrayContaining(['https://r2.kaxolax.test', 'https://*.r2.kaxolax.test']))
  })

  it('reads the origins missing on the web service from the API', async () => {
    apiFetch.mockResolvedValue(
      Response.json({
        realtimeUrl: 'wss://realtime.kaxolax.test',
        storageUrl: 'https://account.eu.r2.cloudflarestorage.com',
        templateUrls: ['https://templates.kaxolax.test/templates.json'],
      }),
    )
    const response = await proxyResponse({
      NODE_ENV: 'production',
      API_INTERNAL_URL: 'http://api.railway.internal:3333',
    })
    expect(apiFetch).toHaveBeenCalledWith(
      'http://api.railway.internal:3333/api/v1/client-config',
      expect.anything(),
    )
    const csp = parseCsp(response.headers.get('content-security-policy') ?? '')
    expect(csp.get('connect-src')).toEqual(
      expect.arrayContaining([
        'wss://realtime.kaxolax.test',
        'https://account.eu.r2.cloudflarestorage.com',
        'https://*.account.eu.r2.cloudflarestorage.com',
        'https://templates.kaxolax.test',
      ]),
    )
    expect(csp.get('img-src')).toEqual(expect.arrayContaining(['https://templates.kaxolax.test']))
  })

  it('lets the development server evaluate code for hot reloading only', async () => {
    const response = await proxyResponse({ NODE_ENV: 'development' })
    const csp = parseCsp(response.headers.get('content-security-policy') ?? '')
    expect(csp.get('script-src')).toContain("'unsafe-eval'")
    // Pile locale par défaut.
    expect(csp.get('connect-src')).toEqual(
      expect.arrayContaining(['ws://localhost:1234', 'http://localhost:8333']),
    )
  })
})
