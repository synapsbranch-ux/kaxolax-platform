import { describe, expect, it } from 'vitest'
import { LOCAL_REALTIME_URL, LOCAL_STORAGE_URL, missingCspOrigins, parseWebEnv } from './env'

describe('web configuration', () => {
  it('falls back to the local stack outside production', () => {
    const config = parseWebEnv({ NODE_ENV: 'development', S3_PUBLIC_ENDPOINT: '' })
    expect(missingCspOrigins({ NODE_ENV: 'development' })).toEqual([])
    expect(config.REALTIME_PUBLIC_URL).toBe(LOCAL_REALTIME_URL)
    expect(config.STORAGE_PUBLIC_URL).toBe(LOCAL_STORAGE_URL)
  })

  it('never uses local origins in production', () => {
    // Chargement au build (NODE_ENV=production, sans variables) : aucun défaut local, pas d'erreur.
    const config = parseWebEnv({ NODE_ENV: 'production' })
    expect(config.REALTIME_PUBLIC_URL).toBeUndefined()
    expect(config.STORAGE_PUBLIC_URL).toBeUndefined()
  })

  it('lists the CSP origins missing in production (read from the API)', () => {
    expect(missingCspOrigins({ NODE_ENV: 'production' })).toEqual([
      'REALTIME_PUBLIC_URL',
      'S3_PUBLIC_ENDPOINT',
      'TEMPLATES_PUBLIC_URL',
    ])
    expect(
      missingCspOrigins({
        NODE_ENV: 'production',
        S3_PUBLIC_ENDPOINT: 'https://account.eu.r2.cloudflarestorage.com',
        TEMPLATES_CATALOG_URL: 'https://templates.kaxolax.com/templates.json',
      }),
    ).toEqual(['REALTIME_PUBLIC_URL'])
  })

  it('falls back to S3_ENDPOINT for storage, like the API', () => {
    const config = parseWebEnv({
      NODE_ENV: 'production',
      REALTIME_PUBLIC_URL: 'wss://realtime.kaxolax.com',
      S3_ENDPOINT: 'https://account.eu.r2.cloudflarestorage.com',
    })
    expect(config.REALTIME_PUBLIC_URL).toBe('wss://realtime.kaxolax.com')
    expect(config.STORAGE_PUBLIC_URL).toBe('https://account.eu.r2.cloudflarestorage.com')
    expect(
      parseWebEnv({
        NODE_ENV: 'production',
        S3_ENDPOINT: 'http://seaweedfs:8333',
        S3_PUBLIC_ENDPOINT: 'https://storage.kaxolax.com',
      }).STORAGE_PUBLIC_URL,
    ).toBe('https://storage.kaxolax.com')
  })

  it('rejects invalid origins', () => {
    expect(() => parseWebEnv({ REALTIME_PUBLIC_URL: 'https://realtime.kaxolax.com' })).toThrow(
      /REALTIME_PUBLIC_URL: Expected a ws:\/\/ or wss:\/\/ URL/,
    )
    expect(() => parseWebEnv({ S3_ENDPOINT: 'ftp://storage' })).toThrow(/S3_ENDPOINT/)
  })
})
