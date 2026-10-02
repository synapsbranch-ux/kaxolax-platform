import { randomBytes } from 'node:crypto'
import { OUTPUT_LIMITS } from './config.js'
import { type ContainerSpec, type DockerClient } from './docker.js'

export const SANDBOX_LIMITS = {
  memoryBytes: 2 * 1024 * 1024 * 1024,
  nanoCpus: 1_000_000_000,
  pids: 256,
  tmpfsBytes: 512 * 1024 * 1024,
} as const

/** Répertoire de travail du projet dans le conteneur. */
export const SANDBOX_WORKDIR = '/compile'

export interface SandboxOptions {
  image: string
  runtime: 'runc' | 'runsc'
}

export interface SandboxRunRequest {
  command: string[]
  /** Répertoire de l'hôte monté sur /compile : le seul point de montage inscriptible. */
  hostWorkdir: string
  /** Répertoire courant de la commande (sous `workdirPath`). */
  workingDir?: string
  readOnly?: boolean
  timeoutMs: number
  labels?: Record<string, string>
  /** Annule l'exécution (arrêt demandé) : le conteneur est tué. */
  signal?: AbortSignal
  /** Appelé pendant l'exécution ; une raison renvoyée tue le conteneur (ex. disque plein). */
  watchdog?: { intervalMs: number; check: () => Promise<string | null> }
}

export interface SandboxResult {
  outcome: 'exited' | 'timeout' | 'stopped' | 'killed'
  exitCode: number | null
  oomKilled: boolean
  killReason: string | null
  durationMs: number
  output: string
}

/**
 * Règles non négociables du sandbox : conteneur neuf, aucun réseau, UID 1000, racine en lecture
 * seule, /tmp en tmpfs, aucune capability, no-new-privileges, 2 Go, 1 CPU, 256 processus, taille
 * de fichier plafonnée, et seul le répertoire du projet monté. Jamais le socket Docker.
 */
export function buildContainerSpec(options: SandboxOptions, run: SandboxRunRequest): ContainerSpec {
  return {
    Image: options.image,
    Cmd: run.command,
    User: '1000:1000',
    WorkingDir: run.workingDir ?? SANDBOX_WORKDIR,
    // L'environnement de l'agent (secrets compris) n'est jamais transmis au conteneur.
    Env: ['HOME=/tmp'],
    Labels: { 'dev.kaxolax.sandbox': 'compile', ...run.labels },
    NetworkDisabled: true,
    HostConfig: {
      Runtime: options.runtime,
      NetworkMode: 'none',
      ReadonlyRootfs: true,
      Tmpfs: {
        '/tmp': `rw,noexec,nosuid,nodev,size=${String(SANDBOX_LIMITS.tmpfsBytes)}`,
        // Seul emplacement exécutable hors image : biber (exécutable PAR) y recopie son cache.
        '/tmp/biber': 'rw,exec,nosuid,nodev,size=268435456,uid=1000,gid=1000,mode=0700',
      },
      CapDrop: ['ALL'],
      SecurityOpt: ['no-new-privileges'],
      Memory: SANDBOX_LIMITS.memoryBytes,
      MemorySwap: SANDBOX_LIMITS.memoryBytes,
      NanoCpus: SANDBOX_LIMITS.nanoCpus,
      PidsLimit: SANDBOX_LIMITS.pids,
      Ulimits: [
        {
          Name: 'fsize',
          Soft: OUTPUT_LIMITS.fileSizeLimitBytes,
          Hard: OUTPUT_LIMITS.fileSizeLimitBytes,
        },
      ],
      Mounts: [
        {
          Type: 'bind',
          Source: run.hostWorkdir,
          Target: SANDBOX_WORKDIR,
          ReadOnly: run.readOnly ?? false,
          BindOptions: { Propagation: 'rprivate' },
        },
      ],
      LogConfig: { Type: 'json-file', Config: { 'max-size': '1m' } },
    },
  }
}

/**
 * Exécution isolée d'une commande sur le répertoire d'un projet : conteneur Docker neuf (agents de
 * l'étape 1) ou processus non privilégié dans la VM du conteneur Cloudflare (`ProcessSandbox`).
 */
export interface CompileSandbox {
  run(run: SandboxRunRequest): Promise<SandboxResult>
  /** Chemin du répertoire du projet tel que le voit la commande (cwd et chemins du log). */
  workdirPath(hostWorkdir: string): string
}

export class Sandbox implements CompileSandbox {
  constructor(
    private readonly docker: DockerClient,
    private readonly options: SandboxOptions,
  ) {}

  /** Le répertoire du projet est monté sur /compile. */
  workdirPath(): string {
    return SANDBOX_WORKDIR
  }

  /** Lance un conteneur neuf, attend sa fin (ou le tue), puis le supprime dans tous les cas. */
  async run(run: SandboxRunRequest): Promise<SandboxResult> {
    const name = `kaxolax-sandbox-${randomBytes(6).toString('hex')}`
    const started = performance.now()
    const id = await this.docker.createContainer(name, buildContainerSpec(this.options, run))
    let outcome: SandboxResult['outcome'] = 'exited'
    let killReason: string | null = null
    const timers: NodeJS.Timeout[] = []

    const kill = (reason: SandboxResult['outcome'], detail: string | null) => {
      if (outcome !== 'exited') return
      outcome = reason
      killReason = detail
      void this.docker.killContainer(id).catch(() => undefined)
    }
    const onAbort = () => {
      kill('stopped', 'stop requested')
    }

    try {
      await this.docker.startContainer(id)
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
          else if (outcome === 'exited')
            timers.push(setTimeout(() => void tick(), watchdog.intervalMs))
        }
        timers.push(setTimeout(() => void tick(), watchdog.intervalMs))
      }
      // Marge au-delà du timeout pour laisser au kill le temps d'aboutir.
      const exitCode = await this.docker.waitContainer(id, run.timeoutMs + 60_000)
      const state = await this.docker.inspectContainer(id)
      const output = await this.docker.containerLogs(id).catch(() => '')
      return {
        outcome,
        exitCode,
        oomKilled: state.State.OOMKilled,
        killReason,
        durationMs: Math.round(performance.now() - started),
        output,
      }
    } finally {
      for (const timer of timers) clearTimeout(timer)
      run.signal?.removeEventListener('abort', onAbort)
      await this.docker.removeContainer(id).catch(() => undefined)
    }
  }
}
