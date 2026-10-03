import { afterEach, describe, expect, it, vi } from 'vitest'
import { checkStartupEnv } from './instrumentation-node'

describe('server startup', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
  })

  it('starts a production server without the CSP origins, which come from the API', () => {
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('REALTIME_PUBLIC_URL', '')
    vi.stubEnv('S3_PUBLIC_ENDPOINT', '')
    vi.stubEnv('S3_ENDPOINT', '')
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    checkStartupEnv()
    expect(exit).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('REALTIME_PUBLIC_URL'))
  })

  it('starts a configured production server silently', () => {
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('REALTIME_PUBLIC_URL', 'wss://realtime.kaxolax.com')
    vi.stubEnv('S3_PUBLIC_ENDPOINT', 'https://account.eu.r2.cloudflarestorage.com')
    vi.stubEnv('TEMPLATES_CATALOG_URL', 'https://templates.kaxolax.com/templates.json')
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    checkStartupEnv()
    expect(exit).not.toHaveBeenCalled()
    expect(warn).not.toHaveBeenCalled()
  })

  it('stops on an invalid value', () => {
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('REALTIME_PUBLIC_URL', 'https://realtime.kaxolax.com')
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never)
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    checkStartupEnv()
    expect(exit).toHaveBeenCalledWith(1)
    expect(error).toHaveBeenCalledWith(expect.stringContaining('REALTIME_PUBLIC_URL'))
  })
})
