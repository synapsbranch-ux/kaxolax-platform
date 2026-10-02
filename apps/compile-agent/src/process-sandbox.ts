import { spawn } from 'node:child_process'
import { chmod, chown, mkdir, readdir, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { OUTPUT_LIMITS } from './config.js'
import {
  type CompileSandbox,
  SANDBOX_LIMITS,
  type SandboxResult,
  type SandboxRunRequest,
} from './sandbox.js'

/** Sortie gardée pour SyncTeX et le diagnostic (stdout et stderr confondus). */
const MAX_OUTPUT_BYTES = 1024 * 1024

export interface ProcessSandboxOptions {
  /** Utilisateur non privilégié des compilations (1000, `tex` dans l'image TeX Live). */
  uid: number
  gid: number
  /**
   * Répertoire temporaire de la commande (`HOME`, `TEXMFVAR`, cache de biber) : vidé avant chaque
   * exécution. `/tmp` dans le conteneur, où l'image TeX Live attend `/tmp/biber`.
   */
  tmpDir: string
  /** PATH de la commande (celui de l'image TeX Live). */
  path: string
  /** Variables non secrètes de l'image dont les scripts TeX Live ont besoin (KAXOLAX_TEXLIVE_YEAR). */
  extraEnv?: Record<string, string>
  /** Enveloppe de la commande (tests) ; par défaut `confinedCommand`. */
  wrap?: (command: string[]) => string[]
  /** Tue tous les processus de l'UID du sandbox (tests : remplaçable) ; par défaut `killAllAs`. */
  killAll?: () => Promise<void>
}

/**
 * Commande confinée, lancée par l'agent (root dans la VM du conteneur Cloudflare) :
 * - `prlimit` : taille de fichier plafonnée (101 Mo), 256 processus pour l'UID, pas de core ;
 * - `choom` : le noyau tue la compilation avant l'agent si la mémoire de la VM s'épuise ;
 * - `setpriv` : UID/GID 1000, groupes vidés, aucune capability (ni héritée, ni dans le bounding
 *   set) et no_new_privs, l'équivalent de `cap-drop ALL` + `no-new-privileges` sous Docker.
 */
export function confinedCommand(
  options: Pick<ProcessSandboxOptions, 'uid' | 'gid'>,
  command: string[],
): string[] {
  return [
    'prlimit',
    `--fsize=${String(OUTPUT_LIMITS.fileSizeLimitBytes)}`,
    `--nproc=${String(SANDBOX_LIMITS.pids)}`,
    '--core=0',
    '--',
    'choom',
    '-n',
    '1000',
    '--',
    'setpriv',
    `--reuid=${String(options.uid)}`,
    `--regid=${String(options.gid)}`,
    '--clear-groups',
    '--no-new-privs',
    '--inh-caps=-all',
    '--bounding-set=-all',
    '--',
    ...command,
  ]
}

/**
 * Tue tous les processus de l'UID du sandbox : `kill(-1)` envoyé par un processus de cet UID
 * atteint tous les autres (un démon détaché par `setsid` compris), jamais l'agent (root).
 */
export async function killAllAs(uid: number, gid: number): Promise<void> {
  await new Promise<void>((resolve) => {
    const killer = spawn(
      'setpriv',
      [
        `--reuid=${String(uid)}`,
        `--regid=${String(gid)}`,
        '--clear-groups',
        '--',
        process.execPath,
        '-e',
        "try { process.kill(-1, 'SIGKILL') } catch {}",
      ],
      { stdio: 'ignore', env: {} },
    )
    killer.once('error', () => {
      resolve()
    })
    killer.once('close', () => {
      resolve()
    })
  })
}

/**
 * Sandbox du conteneur Cloudflare : pas de Docker dans la VM (une VM par projet, sans réseau).
 * Chaque compilation est un processus neuf, confiné et non privilégié, dans son propre groupe ;
 * à la fin (ou au timeout, à l'arrêt, au chien de garde), tous les processus de l'UID sont tués.
 */
export class ProcessSandbox implements CompileSandbox {
  constructor(private readonly options: ProcessSandboxOptions) {}

  /** Pas de montage : la commande voit le vrai chemin du projet. */
  workdirPath(hostWorkdir: string): string {
    return hostWorkdir
  }

  private async resetTmp(): Promise<void> {
    const { tmpDir, uid, gid } = this.options
    await mkdir(tmpDir, { recursive: true })
    for (const entry of await readdir(tmpDir)) {
      await rm(join(tmpDir, entry), { recursive: true, force: true })
    }
    // biber (exécutable PAR) recopie son cache dans /tmp/biber (voir kaxolax-texlive-images).
    const biber = join(tmpDir, 'biber')
    await mkdir(biber, { mode: 0o700 })
    await chown(biber, uid, gid)
  }

  private async killAll(): Promise<void> {
    await (this.options.killAll ?? (() => killAllAs(this.options.uid, this.options.gid)))()
  }

  async run(run: SandboxRunRequest): Promise<SandboxResult> {
    const started = performance.now()
    await this.killAll()
    await this.resetTmp()
    // Le répertoire du projet (files/, propriété de l'UID du sandbox) doit être traversable ;
    // son parent garde state.json, que seul root peut modifier.
    await chmod(dirname(run.hostWorkdir), 0o711)
    const wrap =
      this.options.wrap ?? ((command: string[]) => confinedCommand(this.options, command))
    const [file = '', ...args] = wrap(run.command)
    const child = spawn(file, args, {
      cwd: run.workingDir ?? run.hostWorkdir,
      // L'environnement de l'agent (secrets compris) n'est jamais transmis.
      env: {
        ...this.options.extraEnv,
        PATH: this.options.path,
        HOME: this.options.tmpDir,
        TEXMFVAR: join(this.options.tmpDir, 'texmf-var'),
        LANG: 'C.UTF-8',
      },
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    let output = ''
    let outputBytes = 0
    const collect = (chunk: Buffer) => {
      if (outputBytes >= MAX_OUTPUT_BYTES) return
      outputBytes += chunk.byteLength
      output += chunk.toString('utf8')
    }
    child.stdout.on('data', collect)
    child.stderr.on('data', collect)

    let outcome: SandboxResult['outcome'] = 'exited'
    let killReason: string | null = null
    const timers: NodeJS.Timeout[] = []
    const killGroup = () => {
      if (child.pid === undefined) return
      try {
        process.kill(-child.pid, 'SIGKILL')
      } catch {
        // Groupe déjà terminé.
      }
    }
    const kill = (reason: SandboxResult['outcome'], detail: string | null) => {
      if (outcome !== 'exited') return
      outcome = reason
      killReason = detail
      killGroup()
      // Un processus détaché du groupe (setsid) est atteint par son UID.
      void this.killAll()
    }
    const onAbort = () => {
      kill('stopped', 'stop requested')
    }

    try {
      const exit = new Promise<{ code: number | null; error: Error | null }>((resolve) => {
        child.once('error', (error) => {
          resolve({ code: null, error })
        })
        // « exit » et non « close » : un processus détaché peut garder stdout ouvert.
        child.once('exit', (code) => {
          resolve({ code, error: null })
        })
      })
      timers.push(
        setTimeout(() => {
          kill('timeout', `timed out after ${String(run.timeoutMs)} ms`)
        }, run.timeoutMs),
      )
      if (run.signal?.aborted) onAbort()
      run.signal?.addEventListener('abort', onAbort, { once: true })
      const watchdog = run.watchdog
      if (watchdog) {
        const tick = async () => {
          const reason = await watchdog.check().catch(() => null)
          if (reason !== null) kill('killed', reason)
          else if (outcome === 'exited') {
            timers.push(setTimeout(() => void tick(), watchdog.intervalMs))
          }
        }
        timers.push(setTimeout(() => void tick(), watchdog.intervalMs))
      }
      const closed = new Promise<void>((resolve) => {
        child.once('close', () => {
          resolve()
        })
      })
      const { code, error } = await exit
      // Fin de la sortie (SyncTeX) : au plus une seconde si un processus détaché la garde ouverte.
      await Promise.race([
        closed,
        new Promise<void>((resolve) => {
          timers.push(setTimeout(resolve, 1_000))
        }),
      ])
      if (error) output += `\n${error.message}`
      return {
        outcome,
        exitCode: code,
        // Pas de cgroup par compilation : un manque de mémoire de la VM se voit comme un SIGKILL.
        oomKilled: false,
        killReason,
        durationMs: Math.round(performance.now() - started),
        output,
      }
    } finally {
      for (const timer of timers) clearTimeout(timer)
      run.signal?.removeEventListener('abort', onAbort)
      killGroup()
      await this.killAll()
      child.stdout.destroy()
      child.stderr.destroy()
    }
  }
}
