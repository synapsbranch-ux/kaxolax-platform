import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { inflateSync } from 'node:zlib'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  compileRequest,
  createTestAgent,
  dockerAvailable,
  extractMaliciousCases,
  resourcesFromDirectory,
  RUNTIME,
  type TestAgent,
} from './helpers.js'

/** Format de case.json, partagé avec le runner de kaxolax-texlive-images. */
interface MaliciousCase {
  compiler?: 'pdflatex' | 'xelatex' | 'lualatex'
  command?: string[]
  timeoutSeconds?: number
  expect: {
    status?: string[]
    logContains?: string[]
    logLacks?: string[]
    noLeak?: string[]
    absentFiles?: string[]
  }
}

const available = await dockerAvailable()

/** Texte lisible d'un fichier de sortie (flux PDF décompressés). */
function readable(bytes: Buffer, name: string): string {
  if (!name.endsWith('.pdf')) return bytes.toString('latin1')
  const parts = [bytes.toString('latin1')]
  for (const match of bytes.toString('latin1').matchAll(/stream\r?\n([\s\S]*?)\r?\nendstream/g)) {
    try {
      parts.push(inflateSync(Buffer.from(match[1] ?? '', 'latin1')).toString('latin1'))
    } catch {
      // Flux non compressé ou autre filtre.
    }
  }
  return parts.join('\n')
}

async function allFiles(directory: string): Promise<string[]> {
  const result: string[] = []
  for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) result.push(...(await allFiles(path)))
    else result.push(path)
  }
  return result
}

describe.skipIf(!available)(`malicious suite replayed through the agent (${RUNTIME})`, async () => {
  let agent: TestAgent
  let extracted: string
  let casesDir = ''
  if (available) {
    extracted = await mkdtemp(join(tmpdir(), 'kaxolax-malicious-'))
    casesDir = extractMaliciousCases(extracted)
  }
  const cases = available
    ? (await readdir(casesDir))
        .filter((name) => existsSync(join(casesDir, name, 'case.json')))
        .sort()
    : []

  beforeAll(async () => {
    agent = await createTestAgent()
  })

  afterAll(async () => {
    await agent.cleanup()
    await rm(extracted, { recursive: true, force: true })
  })

  it('ships at least the cases required by the specification', () => {
    for (const name of [
      'read-passwd-input',
      'write18',
      'openout-parent',
      'infinite-loop',
      'huge-pdf',
      'lua-network',
    ]) {
      expect(cases).toContain(name)
    }
  })

  it.each(cases)('%s fails cleanly without leaking anything', async (name) => {
    const dir = join(casesDir, name)
    const spec = JSON.parse(await readFile(join(dir, 'case.json'), 'utf8')) as MaliciousCase
    if (spec.command) return

    const projectId = randomUUID()
    const hostDir = await mkdtemp(join(tmpdir(), 'kaxolax-host-'))
    const canary = join(hostDir, 'host-canary.txt')
    const canaryContent = `KX-HOST-CANARY-${randomUUID()}`
    await writeFile(canary, canaryContent)
    try {
      const resources = await resourcesFromDirectory(agent, projectId, dir, (_path, content) =>
        content.replaceAll('@@HOST_CANARY@@', canary),
      )
      const result = await agent.compiler.compile(
        compileRequest(projectId, resources, {
          compiler: spec.compiler ?? 'pdflatex',
          timeoutMs: (spec.timeoutSeconds ?? 60) * 1000,
        }),
      )
      const expected = spec.expect
      expect(expected.status ?? ['success']).toContain(result.status)

      const files = join(agent.compilesDir, projectId, 'files')
      const log = await readFile(join(files, 'output.log'), 'utf8').catch(() => '')
      for (const text of expected.logContains ?? []) expect(log).toContain(text)
      for (const text of expected.logLacks ?? []) expect(log).not.toContain(text)
      for (const relative of expected.absentFiles ?? [])
        expect(existsSync(join(files, relative))).toBe(false)

      // Rien hors du répertoire de travail : ni à côté de lui chez l'agent, ni chez l'hôte.
      expect((await readdir(join(agent.compilesDir, projectId))).sort()).toEqual([
        'files',
        'state.json',
      ])
      expect(await readdir(hostDir)).toEqual(['host-canary.txt'])

      const markers = (expected.noLeak ?? []).map((marker) =>
        marker.replace('@@HOST_CANARY_CONTENT@@', canaryContent),
      )
      const outputs = [JSON.stringify(result)]
      for (const path of [...(await allFiles(files)), ...(await allFiles(agent.outputsDir))]) {
        if (path.endsWith('.tex')) continue
        outputs.push(readable(await readFile(path), path))
      }
      for (const marker of markers) {
        expect(
          outputs.some((output) => output.includes(marker)),
          `leak of ${marker}`,
        ).toBe(false)
      }
    } finally {
      await rm(hostDir, { recursive: true, force: true })
      await agent.compiler.clearCache(projectId)
    }
  })
})
