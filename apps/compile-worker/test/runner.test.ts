import { compileRequestKey } from '@kaxolax/contracts'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CALLBACK_RETRY_MARGIN_MS, CompileRunner, MESSAGES } from '../src/runner.js'
import {
  buildId,
  callbacksRecorder,
  compileRequest,
  FakeContainer,
  job,
  MemoryBucket,
  MemoryStore,
  otherBuildId,
  OUTPUT_BUCKET,
  PNG,
  PNG_SHA,
  projectId,
  scheduleRecorder,
} from './fakes.js'

let container: FakeContainer
let projectFiles: MemoryBucket
let outputs: MemoryBucket
let store: MemoryStore
let recorder: ReturnType<typeof callbacksRecorder>
let scheduler: ReturnType<typeof scheduleRecorder>
let runner: CompileRunner

function writeRequest(id = buildId, request = compileRequest(id)) {
  outputs.set(compileRequestKey(projectId, id), JSON.stringify(request), 'application/json')
}

beforeEach(() => {
  container = new FakeContainer()
  projectFiles = new MemoryBucket()
  outputs = new MemoryBucket()
  store = new MemoryStore()
  recorder = callbacksRecorder()
  scheduler = scheduleRecorder()
  runner = new CompileRunner({
    container,
    projectFiles,
    outputs,
    outputBucketName: OUTPUT_BUCKET,
    store,
    sendCallback: recorder.send,
    schedule: scheduler.schedule,
    agentId: 'cf-test',
  })
  projectFiles.set(`projects/${projectId}/files/plot`, PNG)
})

afterEach(() => {
  vi.useRealTimers()
})

describe('CompileRunner', () => {
  it('wakes the container, passes the files, copies the outputs to R2 and calls back', async () => {
    writeRequest()
    expect(await runner.enqueue(job())).toBe('preparing')
    await runner.drain()

    expect(recorder.callbacks.map(({ seq, status }) => [seq, status])).toEqual([
      [1, 'preparing'],
      [2, 'running'],
      [3, 'success'],
    ])
    const final = recorder.callbacks[2]
    expect(final).toMatchObject({ durationMs: 1500, entries: [], agentId: 'cf-test' })
    expect(final?.outputFiles?.map((file) => file.name)).toEqual([
      'output.pdf',
      'output.log',
      'output.synctex.gz',
    ])
    // Sorties écrites dans R2 avec leur type, puis supprimées du conteneur.
    const prefix = `outputs/${projectId}/${buildId}/`
    expect(outputs.text(`${prefix}output.pdf`)).toBe('%PDF-1.7')
    expect(outputs.objects.get(`${prefix}output.pdf`)?.contentType).toBe('application/pdf')
    expect(outputs.objects.get(`${prefix}output.synctex.gz`)?.contentType).toBe('application/gzip')
    expect(container.called('DELETE', `/outputs/${projectId}/${buildId}`)).toHaveLength(1)
    // Binaire lu dans R2 et poussé une fois ; la demande passée telle quelle.
    expect(container.blobs.get(PNG_SHA)).toEqual(PNG)
    expect(container.compiled[0]).toEqual(compileRequest())
    expect(await store.get('pending')).toBeUndefined()
  })

  it('skips the wake-up and cached binaries on a warm container', async () => {
    container.running = true
    container.blobs.set(PNG_SHA, PNG)
    writeRequest()
    expect(await runner.enqueue(job())).toBe('queued')
    await runner.drain()
    expect(recorder.callbacks.map((callback) => callback.status)).toEqual(['running', 'success'])
    expect(container.called('PUT', '/blobs/')).toHaveLength(0)
  })

  it('fails without starting the container when the request is missing or not for this bucket', async () => {
    await runner.enqueue(job())
    await runner.drain()
    writeRequest(otherBuildId, {
      ...compileRequest(otherBuildId),
      output: { ...compileRequest(otherBuildId).output, bucket: 'elsewhere' },
    })
    await runner.enqueue(job(otherBuildId))
    await runner.drain()
    expect(recorder.callbacks).toMatchObject([
      { buildId, seq: 1, status: 'error', entries: [{ message: MESSAGES.invalidRequest }] },
      {
        buildId: otherBuildId,
        seq: 1,
        status: 'error',
        entries: [{ message: MESSAGES.invalidRequest }],
      },
    ])
    expect(container.running).toBe(false)
  })

  it('reports a project file missing from R2 and a container that cannot start', async () => {
    projectFiles.objects.clear()
    writeRequest()
    await runner.enqueue(job())
    await runner.drain()
    expect(recorder.callbacks.at(-1)).toMatchObject({
      status: 'error',
      entries: [{ message: 'Missing project file: plot.png' }],
    })
    expect(container.compiled).toHaveLength(0)

    container.running = false
    container.failStart = true
    writeRequest(otherBuildId)
    await runner.enqueue(job(otherBuildId))
    await runner.drain()
    expect(recorder.callbacks.at(-1)).toMatchObject({
      buildId: otherBuildId,
      status: 'error',
      entries: [{ message: MESSAGES.startFailed }],
    })
  })

  it('stops the running build when it is cancelled', async () => {
    container.running = true
    container.hold()
    writeRequest()
    await runner.enqueue(job())
    const draining = runner.drain()
    await new Promise((resolve) => setTimeout(resolve, 10))
    await runner.cancel(buildId)
    await draining
    expect(container.called('POST', `/projects/${projectId}/stop`)).toHaveLength(1)
    expect(recorder.callbacks.map((callback) => callback.status)).toEqual(['running', 'cancelled'])
    expect(recorder.callbacks.at(-1)).toMatchObject({ entries: [] })
  })

  it('does not start latexmk when the build is cancelled while binaries are sent', async () => {
    container.running = true
    container.holdBlobs = true
    container.hold()
    writeRequest()
    await runner.enqueue(job())
    const draining = runner.drain()
    await new Promise((resolve) => setTimeout(resolve, 10))
    await runner.cancel(buildId)
    await draining
    expect(container.compiled).toHaveLength(0)
    expect(recorder.callbacks.map((callback) => callback.status)).toEqual(['running', 'cancelled'])
  })

  it('sends /stop again for a build already marked as cancelled', async () => {
    container.running = true
    container.hold()
    writeRequest()
    await runner.enqueue(job())
    const draining = runner.drain()
    await new Promise((resolve) => setTimeout(resolve, 10))
    await runner.cancel(buildId)
    await runner.cancel(buildId)
    await draining
    expect(container.called('POST', `/projects/${projectId}/stop`)).toHaveLength(2)
  })

  it('always calls back with an error when the run throws', async () => {
    outputs.failGet = true
    await runner.enqueue(job())
    await runner.drain()
    expect(recorder.callbacks).toMatchObject([
      { buildId, seq: 1, status: 'error', entries: [{ message: MESSAGES.compilerFailed }] },
    ])
    expect(await store.get('pending')).toBeUndefined()
  })

  it('copies only the expected outputs of the build into R2', async () => {
    container.running = true
    container.blobs.set(PNG_SHA, PNG)
    const foreign = `outputs/${projectId}/${otherBuildId}/output.pdf`
    container.extraOutputs = [
      { name: 'output.pdf', s3Key: foreign, content: 'forged' },
      { name: 'big.bin', s3Key: `outputs/${projectId}/${buildId}/big.bin`, content: 'junk' },
      {
        name: 'request.json',
        s3Key: compileRequestKey(projectId, buildId),
        content: '{}',
      },
    ]
    writeRequest()
    await runner.enqueue(job())
    await runner.drain()
    const final = recorder.callbacks.at(-1)
    expect(final?.status).toBe('success')
    expect(final?.outputFiles?.map((file) => file.name)).toEqual([
      'output.pdf',
      'output.log',
      'output.synctex.gz',
    ])
    expect(outputs.objects.has(foreign)).toBe(false)
    expect(outputs.objects.has(`outputs/${projectId}/${buildId}/big.bin`)).toBe(false)
    expect(outputs.text(compileRequestKey(projectId, buildId))).toContain(buildId)
  })

  it('drops a queued build that is cancelled before it starts', async () => {
    writeRequest()
    await runner.enqueue(job())
    await runner.cancel(buildId)
    await runner.drain()
    expect(recorder.callbacks).toEqual([])
  })

  it('replaces the running build by a newer one', async () => {
    container.running = true
    container.hold()
    writeRequest()
    writeRequest(otherBuildId)
    await runner.enqueue(job())
    const draining = runner.drain()
    await new Promise((resolve) => setTimeout(resolve, 10))
    await runner.enqueue(job(otherBuildId))
    await draining
    // Une compilation par alarme : la suivante est programmée dans une nouvelle alarme.
    expect(recorder.callbacks.map(({ status }) => status)).toEqual(['running', 'cancelled'])
    expect(scheduler.scheduled).toEqual([[0, 'drainQueue']])
    await runner.drain()
    expect(scheduler.scheduled).toHaveLength(1)
    expect(recorder.callbacks.map(({ buildId: id, status }) => [id, status])).toEqual([
      [buildId, 'running'],
      [buildId, 'cancelled'],
      [otherBuildId, 'running'],
      [otherBuildId, 'success'],
    ])
  })

  it('keeps a final callback the API did not receive and retries it until its deadline', async () => {
    container.running = true
    writeRequest()
    recorder.outcomes.push('delivered', 'unreachable')
    await runner.enqueue(job())
    await runner.drain()
    expect(recorder.callbacks.map(({ status }) => status)).toEqual(['running', 'success'])
    expect(scheduler.scheduled).toEqual([[30, 'retryCallbacks']])

    // API toujours injoignable : reprogrammé ; puis reçu : plus rien à réessayer.
    recorder.outcomes.push('unreachable')
    await runner.retryCallbacks()
    expect(scheduler.scheduled).toHaveLength(2)
    await runner.retryCallbacks()
    const sent = recorder.callbacks.slice(2)
    expect(sent.map(({ status, seq }) => [status, seq])).toEqual([
      ['success', 2],
      ['success', 2],
    ])
    expect(sent[1]?.outputFiles).toHaveLength(3)
    expect(scheduler.scheduled).toHaveLength(2)
    await runner.retryCallbacks()
    expect(recorder.callbacks).toHaveLength(4)
  })

  it('drops an undelivered final callback after the timeout of the build plus the margin', async () => {
    container.running = true
    writeRequest()
    recorder.outcomes.push('delivered', 'unreachable')
    await runner.enqueue(job())
    await runner.drain()
    vi.useFakeTimers({
      now: Date.now() + compileRequest().timeoutMs + CALLBACK_RETRY_MARGIN_MS + 1,
    })
    await runner.retryCallbacks()
    expect(recorder.callbacks).toHaveLength(2)
    expect(scheduler.scheduled).toHaveLength(1)
  })

  it('restores the SyncTeX file of the build into a recycled container', async () => {
    const prefix = `outputs/${projectId}/${buildId}/`
    expect(
      await runner.synctex(
        projectId,
        'code',
        { file: 'thesis/main.tex', line: '3', column: '0' },
        buildId,
      ),
    ).toBeNull()

    writeRequest()
    outputs.set(`${prefix}output.synctex.gz`, 'synctex')
    const result = await runner.synctex(
      projectId,
      'code',
      { file: 'thesis/main.tex', line: '3', column: '0' },
      buildId,
    )
    expect(container.restoredRoot).toBe('thesis/main.tex')
    expect(result).toMatchObject({
      pdf: [{ page: 1 }],
      query: '?file=thesis%2Fmain.tex&line=3&column=0',
    })
    // Fichier déjà présent : pas de nouvelle restauration.
    await runner.synctex(projectId, 'code', { file: 'main.tex', line: '1', column: '0' }, buildId)
    expect(container.called('PUT', `/projects/${projectId}/synctex`)).toHaveLength(1)
  })

  it('clears the cache only on a running container', async () => {
    expect(await runner.clearCache(projectId)).toBe(true)
    expect(container.calls).toHaveLength(0)
    container.running = true
    expect(await runner.clearCache(projectId)).toBe(true)
    expect(container.called('POST', `/projects/${projectId}/clear-cache`)).toHaveLength(1)
  })
})
