import type { ClientConfig } from '@kaxolax/contracts'
import { describe, expect, it, vi } from 'vitest'
import { createCspSourcesResolver } from './csp-sources'

const REMOTE: ClientConfig = {
  realtimeUrl: 'wss://realtime.kaxolax.test',
  storageUrl: 'https://account.eu.r2.cloudflarestorage.com',
  templateUrls: ['https://templates.kaxolax.test/templates.json'],
}

const EMPTY_ENV = {
  REALTIME_PUBLIC_URL: undefined,
  STORAGE_PUBLIC_URL: undefined,
  TEMPLATES_PUBLIC_URL: undefined,
  TEMPLATES_CATALOG_URL: undefined,
}

describe('CSP origins', () => {
  it('uses the web variables alone when they are all set', async () => {
    const fetchConfig = vi.fn(() => Promise.resolve(REMOTE))
    const resolve = createCspSourcesResolver({
      env: {
        REALTIME_PUBLIC_URL: 'wss://rt.example.test',
        STORAGE_PUBLIC_URL: 'https://storage.example.test',
        TEMPLATES_PUBLIC_URL: 'https://tpl.example.test/',
        TEMPLATES_CATALOG_URL: undefined,
      },
      fetchConfig,
    })
    await expect(resolve()).resolves.toEqual({
      realtimeUrl: 'wss://rt.example.test',
      storageUrl: 'https://storage.example.test',
      templateUrls: ['https://tpl.example.test/', undefined],
    })
    expect(fetchConfig).not.toHaveBeenCalled()
  })

  it('reads the missing origins from the API, variables first', async () => {
    const fetchConfig = vi.fn(() => Promise.resolve(REMOTE))
    const resolve = createCspSourcesResolver({
      env: { ...EMPTY_ENV, STORAGE_PUBLIC_URL: 'https://storage.example.test' },
      fetchConfig,
    })
    await expect(resolve()).resolves.toEqual({
      realtimeUrl: REMOTE.realtimeUrl,
      storageUrl: 'https://storage.example.test',
      templateUrls: [undefined, undefined, ...REMOTE.templateUrls],
    })
    await resolve()
    expect(fetchConfig).toHaveBeenCalledTimes(1)
  })

  it('keeps serving pages when the API is unreachable, then retries', async () => {
    let time = 0
    const onError = vi.fn()
    const fetchConfig = vi
      .fn<() => Promise<ClientConfig>>()
      .mockRejectedValueOnce(new Error('ECONNREFUSED'))
      .mockResolvedValue(REMOTE)
    const resolve = createCspSourcesResolver({
      env: EMPTY_ENV,
      fetchConfig,
      now: () => time,
      onError,
    })
    expect((await resolve()).realtimeUrl).toBeUndefined()
    expect(onError).toHaveBeenCalledTimes(1)
    time += 10_000
    expect((await resolve()).realtimeUrl).toBeUndefined()
    expect(fetchConfig).toHaveBeenCalledTimes(1)
    time += 30_000
    expect((await resolve()).realtimeUrl).toBe(REMOTE.realtimeUrl)
  })

  it('refreshes in the background and keeps the last answer on failure', async () => {
    let time = 0
    const fetchConfig = vi
      .fn<() => Promise<ClientConfig>>()
      .mockResolvedValueOnce(REMOTE)
      .mockRejectedValueOnce(new Error('timeout'))
    const resolve = createCspSourcesResolver({
      env: EMPTY_ENV,
      fetchConfig,
      now: () => time,
      onError: () => undefined,
    })
    await resolve()
    time += 6 * 60_000
    expect((await resolve()).realtimeUrl).toBe(REMOTE.realtimeUrl)
    await Promise.resolve()
    expect(fetchConfig).toHaveBeenCalledTimes(2)
    expect((await resolve()).realtimeUrl).toBe(REMOTE.realtimeUrl)
  })
})
