import { describe, expect, it } from 'vitest'
import { loadConfig } from '../src/config.js'

const BASE = {
  REALTIME_TOKEN_SECRET: 'test-realtime-token-secret-0123456789abcdef',
  INTERNAL_TOKEN: 'test-internal-token-0123456789abcdefghij',
  DATABASE_URL: 'postgres://kaxolax:kaxolax@127.0.0.1:5432/kaxolax',
}

describe('configuration', () => {
  it('runs a single instance without Redis in development and in tests', () => {
    expect(loadConfig({ ...BASE }).REDIS_URL).toBeUndefined()
    expect(loadConfig({ ...BASE, NODE_ENV: 'development', REDIS_URL: '' }).NODE_ENV).toBe(
      'development',
    )
    expect(loadConfig({ ...BASE, NODE_ENV: 'test' }).REDIS_URL).toBeUndefined()
  })

  it('refuses to start in production without REDIS_URL, with a clear message', () => {
    for (const redis of [undefined, '']) {
      const env = {
        ...BASE,
        NODE_ENV: 'production',
        ...(redis === undefined ? {} : { REDIS_URL: redis }),
      }
      expect(() => loadConfig(env)).toThrow(/REDIS_URL: Required in production/)
    }
  })

  it('accepts production with a Redis URL, and still checks its scheme', () => {
    const config = loadConfig({ ...BASE, NODE_ENV: 'production', REDIS_URL: 'rediss://redis:6380' })
    expect(config.REDIS_URL).toBe('rediss://redis:6380')
    expect(() =>
      loadConfig({ ...BASE, NODE_ENV: 'production', REDIS_URL: 'http://redis:6379' }),
    ).toThrow(/REDIS_URL: Expected a redis:\/\/ or rediss:\/\/ URL/)
  })
})
