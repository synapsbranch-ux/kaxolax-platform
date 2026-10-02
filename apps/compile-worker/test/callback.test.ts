import { verifyCallback, type WorkerCallback } from '@kaxolax/contracts'
import { describe, expect, it } from 'vitest'
import { sendCallback } from '../src/callback.js'
import { buildId, projectId } from './fakes.js'

const secret = 'test-compile-worker-secret-0123456789abcdef'
const callback: WorkerCallback = { projectId, buildId, seq: 1, status: 'running' }

function fakeFetch(statuses: (number | Error)[]) {
  const requests: Request[] = []
  const fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    requests.push(new Request(input, init))
    const next = statuses.shift() ?? 200
    return next instanceof Error
      ? Promise.reject(next)
      : Promise.resolve(new Response('{}', { status: next }))
  }
  return { fetch, requests }
}

describe('sendCallback', () => {
  it('signs the body for the API', async () => {
    const { fetch, requests } = fakeFetch([200])
    expect(await sendCallback(callback, { url: 'https://api.example/cb', secret, fetch })).toBe(
      'delivered',
    )
    const [request] = requests
    const body = (await request?.text()) ?? ''
    expect(JSON.parse(body)).toEqual(callback)
    const signed = {
      timestamp: request?.headers.get('x-kaxolax-timestamp') ?? undefined,
      signature: request?.headers.get('x-kaxolax-signature') ?? undefined,
    }
    expect(await verifyCallback(body, signed, secret)).toBe(true)
  })

  it('retries network errors, 429 and 5xx, never 4xx, and never throws', async () => {
    const options = { url: 'https://api.example/cb', secret, delayMs: () => 1 }
    const flaky = fakeFetch([new Error('reset'), 503, 429, 200])
    expect(await sendCallback(callback, { ...options, fetch: flaky.fetch })).toBe('delivered')
    expect(flaky.requests).toHaveLength(4)

    const refused = fakeFetch([401, 200])
    expect(await sendCallback(callback, { ...options, fetch: refused.fetch })).toBe('refused')
    expect(refused.requests).toHaveLength(1)

    const down = fakeFetch([500, 500, 500, 500, 500])
    expect(await sendCallback(callback, { ...options, fetch: down.fetch })).toBe('unreachable')
    expect(down.requests).toHaveLength(4)
  })
})
