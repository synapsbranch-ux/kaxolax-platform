import { describe, expect, it } from 'vitest'
import { clientConfigSchema } from './client-config.js'

describe('client config', () => {
  it('accepts the origins given to the browser', () => {
    const config = {
      realtimeUrl: 'wss://realtime.kaxolax.com',
      storageUrl: 'https://account.eu.r2.cloudflarestorage.com',
      templateUrls: ['https://templates.kaxolax.com/templates.json'],
    }
    expect(clientConfigSchema.parse(config)).toEqual(config)
    expect(clientConfigSchema.parse({ ...config, storageUrl: null, templateUrls: [] })).toEqual({
      ...config,
      storageUrl: null,
      templateUrls: [],
    })
  })

  it('rejects other schemes', () => {
    const base = { realtimeUrl: 'wss://realtime.kaxolax.com', storageUrl: null, templateUrls: [] }
    expect(() => clientConfigSchema.parse({ ...base, realtimeUrl: 'https://x.test' })).toThrow()
    expect(() => clientConfigSchema.parse({ ...base, storageUrl: 'javascript:alert(1)' })).toThrow()
    expect(() => clientConfigSchema.parse({ ...base, templateUrls: ['ftp://x.test/'] })).toThrow()
  })
})
