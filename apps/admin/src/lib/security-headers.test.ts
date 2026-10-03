import { type NextFetchEvent, NextRequest } from 'next/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ADMIN_SECURITY_HEADERS } from './security-headers'

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

async function proxyResponse(nodeEnv: string) {
  vi.resetModules()
  vi.stubEnv('NODE_ENV', nodeEnv)
  vi.stubEnv('CLERK_PUBLISHABLE_KEY', `pk_live_${Buffer.from(`${FAPI}$`).toString('base64')}`)
  vi.stubEnv('CLERK_SECRET_KEY', 'sk_live_test_secret_key_not_used_without_session')
  const { default: proxy } = await import('@/proxy')
  const response = await proxy(
    new NextRequest('https://admin.kaxolax.test/users', { headers: { accept: 'text/html' } }),
    {} as NextFetchEvent,
  )
  if (!response) throw new Error('no response from the proxy')
  return response
}

describe('en-têtes de sécurité', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('ne laisse jamais afficher, indexer ni deviner le type des réponses', () => {
    expect(ADMIN_SECURITY_HEADERS).toEqual(
      expect.arrayContaining([
        { key: 'X-Frame-Options', value: 'DENY' },
        { key: 'X-Robots-Tag', value: 'noindex, nofollow' },
        { key: 'X-Content-Type-Options', value: 'nosniff' },
        { key: 'Referrer-Policy', value: 'no-referrer' },
      ]),
    )
    const permissions = ADMIN_SECURITY_HEADERS.find((header) => header.key === 'Permissions-Policy')
    expect(permissions?.value).toContain('payment=()')
  })

  it('pose une CSP stricte avec un nonce par requête, sans eval en production', async () => {
    const response = await proxyResponse('production')
    const header = response.headers.get('content-security-policy') ?? ''
    const csp = parseCsp(header)
    const nonce = response.headers.get('x-nonce') ?? ''
    expect(nonce).not.toBe('')
    expect(csp.get('script-src')).toEqual(
      expect.arrayContaining(["'strict-dynamic'", `'nonce-${nonce}'`]),
    )
    expect(csp.get('script-src')).not.toContain("'unsafe-eval'")
    expect(csp.get('script-src')).not.toContain("'wasm-unsafe-eval'")
    expect(csp.get('frame-ancestors')).toEqual(["'none'"])
    expect(csp.get('object-src')).toEqual(["'none'"])
    expect(csp.get('connect-src')).toEqual(expect.arrayContaining(["'self'", FAPI]))
    expect(csp.get('connect-src')).not.toEqual(
      expect.arrayContaining([expect.stringMatching(/^wss?:/)]),
    )
    expect(response.headers.get('x-middleware-request-content-security-policy')).toBe(header)
  })

  it("n'autorise l'eval qu'au serveur de développement", async () => {
    const response = await proxyResponse('development')
    const csp = parseCsp(response.headers.get('content-security-policy') ?? '')
    expect(csp.get('script-src')).toContain("'unsafe-eval'")
  })
})
