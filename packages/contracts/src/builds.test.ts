import { describe, expect, it } from 'vitest'
import {
  buildStatusSchema,
  compileEventSchema,
  compileRequestKey,
  fitProjectEvent,
  isFinalBuildStatus,
  MAX_PROJECT_EVENT_BYTES,
  projectEventSchema,
  workerCallbackSchema,
} from './builds.js'
import {
  signCallback,
  signCompileWorkerToken,
  verifyCallback,
  verifyCompileWorkerToken,
} from './compile-worker-auth.js'

const projectId = '6f1c2d3e-4b5a-4c7d-8e9f-0a1b2c3d4e5f'
const buildId = '0b8f7e6d-5c4b-4a39-8281-7f6e5d4c3b2a'
const secret = 'test-compile-worker-secret-0123456789'

describe('build statuses', () => {
  it('separates active and final statuses', () => {
    expect(buildStatusSchema.options.filter((status) => isFinalBuildStatus(status))).toEqual([
      'success',
      'failure',
      'timeout',
      'error',
      'cancelled',
    ])
  })

  it('keeps the request next to the outputs of the build', () => {
    expect(compileRequestKey(projectId, buildId)).toBe(
      `outputs/${projectId}/${buildId}/request.json`,
    )
  })
})

describe('workerCallbackSchema', () => {
  const final = {
    projectId,
    buildId,
    seq: 3,
    status: 'success',
    durationMs: 1200,
    entries: [],
    outputFiles: [
      { name: 'output.pdf', s3Key: `outputs/${projectId}/${buildId}/output.pdf`, sizeBytes: 10 },
    ],
  }

  it('accepts a progress callback and a complete final callback', () => {
    expect(
      workerCallbackSchema.safeParse({ projectId, buildId, seq: 1, status: 'preparing' }).success,
    ).toBe(true)
    expect(workerCallbackSchema.safeParse(final).success).toBe(true)
  })

  it('refuses queued, a final callback without result, and outputs of another build', () => {
    expect(
      workerCallbackSchema.safeParse({ projectId, buildId, seq: 1, status: 'queued' }).success,
    ).toBe(false)
    expect(
      workerCallbackSchema.safeParse({ projectId, buildId, seq: 2, status: 'failure' }).success,
    ).toBe(false)
    expect(
      workerCallbackSchema.safeParse({
        ...final,
        outputFiles: [
          { name: 'output.pdf', s3Key: `outputs/${projectId}/other/output.pdf`, sizeBytes: 1 },
        ],
      }).success,
    ).toBe(false)
    expect(workerCallbackSchema.safeParse({ ...final, seq: 0 }).success).toBe(false)
  })
})

describe('project events', () => {
  it('validates a compile event through the union', () => {
    const event = { type: 'compile', projectId, buildId, status: 'running', result: null }
    expect(projectEventSchema.parse(event)).toEqual(compileEventSchema.parse(event))
    expect(projectEventSchema.safeParse({ ...event, type: 'other' }).success).toBe(false)
  })
})

describe('compile worker token', () => {
  it('round-trips and is bound to the project', async () => {
    const token = await signCompileWorkerToken(projectId, secret, 1_000)
    expect(await verifyCompileWorkerToken(token, secret, 1_010)).toEqual({
      aud: 'compile-worker',
      projectId,
      exp: 1_060,
    })
  })

  it('refuses an expired token, another secret and a tampered payload', async () => {
    const token = await signCompileWorkerToken(projectId, secret, 1_000)
    expect(await verifyCompileWorkerToken(token, secret, 1_060)).toBeNull()
    expect(await verifyCompileWorkerToken(token, `${secret}x`, 1_010)).toBeNull()
    const [version, , signature] = token.split('.')
    const forged = btoa(
      JSON.stringify({ aud: 'compile-worker', projectId: buildId, exp: 1_060 }),
    ).replaceAll('=', '')
    expect(
      await verifyCompileWorkerToken(
        `${String(version)}.${forged}.${String(signature)}`,
        secret,
        1_010,
      ),
    ).toBeNull()
    expect(await verifyCompileWorkerToken('v1.abc', secret, 1_010)).toBeNull()
    // Un jeton signé dans le futur (durée de vie trop longue vue d'aujourd'hui) est refusé.
    expect(
      await verifyCompileWorkerToken(
        await signCompileWorkerToken(projectId, secret, 5_000),
        secret,
        1_000,
      ),
    ).toBeNull()
  })
})

describe('callback signature', () => {
  const body = JSON.stringify({ projectId, buildId, seq: 1, status: 'running' })

  it('accepts the signed body within the time window', async () => {
    const headers = await signCallback(body, secret, 10_000)
    const signed = {
      timestamp: headers['x-kaxolax-timestamp'],
      signature: headers['x-kaxolax-signature'],
    }
    expect(await verifyCallback(body, signed, secret, 10_100)).toBe(true)
    expect(await verifyCallback(body, signed, secret, 10_301)).toBe(false)
    expect(await verifyCallback(`${body} `, signed, secret, 10_100)).toBe(false)
    expect(await verifyCallback(body, { ...signed, timestamp: '10001' }, secret, 10_100)).toBe(
      false,
    )
    expect(await verifyCallback(body, { ...signed, signature: undefined }, secret, 10_100)).toBe(
      false,
    )
  })

  it('never accepts a worker token as a callback signature', async () => {
    const token = await signCompileWorkerToken(projectId, secret, 10_000)
    const signature = `v1=${String(token.split('.')[2])}`
    expect(await verifyCallback(body, { timestamp: '10000', signature }, secret, 10_000)).toBe(
      false,
    )
  })
})

describe('fitProjectEvent', () => {
  const event = (message: string) => ({
    type: 'compile' as const,
    projectId,
    buildId,
    status: 'failure' as const,
    result: {
      buildId,
      status: 'failure' as const,
      durationMs: 10,
      pdfUrl: null,
      logUrl: null,
      entries: [{ level: 'warning' as const, file: null, line: null, message, raw: message }],
    },
  })

  it('keeps an event that fits the realtime body limit', () => {
    const small = event('Overfull \\hbox')
    expect(fitProjectEvent(small)).toBe(small)
  })

  it('drops a result too large for the realtime service, which the client reads from the API', () => {
    const large = fitProjectEvent(event('x'.repeat(MAX_PROJECT_EVENT_BYTES / 2)))
    expect(large).toMatchObject({ status: 'failure', result: null, resultOmitted: true })
    expect(projectEventSchema.parse(large)).toEqual(large)
  })
})
