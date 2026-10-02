import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { spawn, spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { confinedCommand, killAllAs, ProcessSandbox } from '../../src/process-sandbox.js'

let root: string
let workdir: string
let tmp: string
let killAllCalls: number

const uid = process.getuid?.() ?? 1000
const gid = process.getgid?.() ?? 1000

/** Sans abandon de privilèges ni limites (testés à part) : la commande tourne telle quelle. */
function sandbox() {
  return new ProcessSandbox({
    uid,
    gid,
    tmpDir: tmp,
    path: process.env.PATH ?? '/usr/bin:/bin',
    extraEnv: { KAXOLAX_TEXLIVE_YEAR: '2026' },
    wrap: (command) => command,
    killAll: () => {
      killAllCalls++
      return Promise.resolve()
    },
  })
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'kaxolax-process-'))
  workdir = join(root, 'project', 'files')
  tmp = join(root, 'tmp')
  await mkdir(workdir, { recursive: true })
  killAllCalls = 0
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('confinedCommand', () => {
  it('limits the process, then drops to the sandbox user without capabilities', () => {
    expect(confinedCommand({ uid: 1000, gid: 1000 }, ['latexmk', '-norc', 'main.tex'])).toEqual([
      'prlimit',
      `--fsize=${String(101 * 1024 * 1024)}`,
      '--nproc=256',
      '--core=0',
      '--',
      'choom',
      '-n',
      '1000',
      '--',
      'setpriv',
      '--reuid=1000',
      '--regid=1000',
      '--clear-groups',
      '--no-new-privs',
      '--inh-caps=-all',
      '--bounding-set=-all',
      '--',
      'latexmk',
      '-norc',
      'main.tex',
    ])
  })
})

describe('ProcessSandbox', () => {
  it('runs in the project directory with a clean environment and a fresh tmp', async () => {
    await mkdir(tmp, { recursive: true })
    await writeFile(join(tmp, 'leftover'), 'previous compile')
    process.env.KAXOLAX_SECRET_FOR_TEST = 'must-not-leak'
    try {
      const result = await sandbox().run({
        command: ['sh', '-c', 'pwd; env | sort; echo done >&2; exit 3'],
        hostWorkdir: workdir,
        workingDir: workdir,
        timeoutMs: 10_000,
      })
      expect(result).toMatchObject({ outcome: 'exited', exitCode: 3, oomKilled: false })
      expect(result.output).toContain(workdir)
      expect(result.output).toContain(`HOME=${tmp}`)
      expect(result.output).toContain(`TEXMFVAR=${join(tmp, 'texmf-var')}`)
      expect(result.output).toContain('KAXOLAX_TEXLIVE_YEAR=2026')
      expect(result.output).toContain('done')
      expect(result.output).not.toContain('KAXOLAX_SECRET_FOR_TEST')
    } finally {
      delete process.env.KAXOLAX_SECRET_FOR_TEST
    }
    expect(await readdir(tmp)).toEqual(['biber'])
    expect((await stat(join(root, 'project'))).mode & 0o777).toBe(0o711)
    // Avant et après chaque exécution : tous les processus de l'UID sont tués.
    expect(killAllCalls).toBe(2)
  })

  it('kills the whole process group on timeout', async () => {
    const started = Date.now()
    const result = await sandbox().run({
      command: ['sh', '-c', 'sleep 30 & sleep 30; wait'],
      hostWorkdir: workdir,
      timeoutMs: 300,
    })
    expect(result.outcome).toBe('timeout')
    expect(Date.now() - started).toBeLessThan(5_000)
  })

  it('stops on abort and when the watchdog reports a problem', async () => {
    const controller = new AbortController()
    setTimeout(() => {
      controller.abort()
    }, 200)
    const stopped = await sandbox().run({
      command: ['sleep', '30'],
      hostWorkdir: workdir,
      timeoutMs: 10_000,
      signal: controller.signal,
    })
    expect(stopped).toMatchObject({ outcome: 'stopped', killReason: 'stop requested' })

    const killed = await sandbox().run({
      command: ['sleep', '30'],
      hostWorkdir: workdir,
      timeoutMs: 10_000,
      watchdog: { intervalMs: 50, check: () => Promise.resolve('disk full') },
    })
    expect(killed).toMatchObject({ outcome: 'killed', killReason: 'disk full' })
  })

  it('reports a command that cannot start', async () => {
    const result = await sandbox().run({
      command: ['/nonexistent/latexmk'],
      hostWorkdir: workdir,
      timeoutMs: 1_000,
    })
    expect(result.outcome).toBe('exited')
    expect(result.exitCode).toBeNull()
    expect(result.output).toContain('ENOENT')
  })
})

// Vrai confinement : root et util-linux (prlimit, choom, setpriv) requis, comme dans le conteneur.
// UID inutilisé, pour ne jamais toucher un autre processus de la machine de test.
const TEST_UID = 54_321
const confinementAvailable =
  process.getuid?.() === 0 &&
  ['prlimit', 'choom', 'setpriv'].every(
    (tool) => spawnSync('sh', ['-c', `command -v ${tool}`]).status === 0,
  )

describe.runIf(confinementAvailable)('ProcessSandbox confinement', () => {
  it('runs as the sandbox user, limited, without capabilities', async () => {
    const confined = new ProcessSandbox({
      uid: TEST_UID,
      gid: TEST_UID,
      tmpDir: tmp,
      path: process.env.PATH ?? '/usr/bin:/bin',
    })
    const result = await confined.run({
      command: [
        'sh',
        '-c',
        'id -u; id -g; grep -E "^Max (file size|processes)" /proc/self/limits; grep -E "^(CapEff|CapBnd|NoNewPrivs)" /proc/self/status; cat /proc/self/oom_score_adj',
      ],
      hostWorkdir: workdir,
      timeoutMs: 10_000,
    })
    expect(result.exitCode).toBe(0)
    const lines = result.output.trim().split('\n')
    expect(lines.slice(0, 2)).toEqual([String(TEST_UID), String(TEST_UID)])
    expect(result.output).toMatch(new RegExp(`Max file size\\s+${String(101 * 1024 * 1024)}\\s`))
    expect(result.output).toMatch(/Max processes\s+256\s+256/)
    expect(result.output).toMatch(/CapEff:\s+0+\n/)
    expect(result.output).toMatch(/CapBnd:\s+0+\n/)
    expect(result.output).toMatch(/NoNewPrivs:\s+1/)
    expect(lines.at(-1)).toBe('1000')
  })

  it('kills every process of the sandbox user, in other process groups too', async () => {
    const escaped = spawn(
      'setpriv',
      [
        `--reuid=${String(TEST_UID)}`,
        `--regid=${String(TEST_UID)}`,
        '--clear-groups',
        'sleep',
        '30',
      ],
      { stdio: 'ignore', detached: true },
    )
    const exited = new Promise<NodeJS.Signals | null>((resolve) => {
      escaped.once('exit', (_code, signal) => {
        resolve(signal)
      })
    })
    await new Promise((resolve) => setTimeout(resolve, 200))
    await killAllAs(TEST_UID, TEST_UID)
    expect(await exited).toBe('SIGKILL')
  })
})
