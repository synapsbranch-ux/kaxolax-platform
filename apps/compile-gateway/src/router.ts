import {
  agentCompileResponseSchema,
  type CompileRequest,
  type GatewayCompileResponse,
  synctexCodeResponseSchema,
  type SynctexCodeQuery,
  type SynctexCodeResponse,
  synctexPdfResponseSchema,
  type SynctexPdfQuery,
  type SynctexPdfResponse,
} from '@kaxolax/contracts'
import type { Redis } from 'ioredis'
import type { Logger } from 'pino'
import { type AgentPool, AgentUnreachableError } from './agents.js'

export const lockKey = (projectId: string) => `compile:lock:${projectId}`
export const affinityKey = (projectId: string) => `compile:agent:${projectId}`

/** Le verrou survit un peu au timeout de la compilation (synchronisation, envoi des sorties). */
const LOCK_MARGIN_MS = 60_000
/** Délai accordé à l'agent au-delà du timeout de la compilation, avant d'abandonner l'appel. */
const AGENT_CALL_MARGIN_MS = 60_000
/** Arrêter une compilation attend la fin du conteneur (docker kill, nettoyage). */
const STOP_TIMEOUT_MS = 30_000
const SYNCTEX_TIMEOUT_MS = 15_000

/** Libère le verrou seulement s'il appartient encore à cette compilation. */
const RELEASE_LOCK = `
if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) end
return 0`

/**
 * Remplace l'affinité seulement si elle vaut encore ce qu'on a lu (absente, ou l'agent tombé) ;
 * sinon, une autre requête a choisi entre-temps et son choix l'emporte.
 */
const SWAP_AFFINITY = `
local current = redis.call('get', KEYS[1])
if current == false or current == ARGV[1] then
  redis.call('set', KEYS[1], ARGV[2], 'EX', ARGV[3])
  return ARGV[2]
end
return current`

export class NoAgentAvailableError extends Error {
  constructor() {
    super('No compile agent is available')
    this.name = 'NoAgentAvailableError'
  }
}

export class NoCompileOutputError extends Error {
  constructor() {
    super('This project has not been compiled on any agent')
    this.name = 'NoCompileOutputError'
  }
}

export interface RouterOptions {
  affinityTtlSeconds: number
  logger: Logger
}

/** Verrous par projet, affinité vers un agent et bascule vers un autre agent. */
export class CompileRouter {
  constructor(
    private readonly redis: Redis,
    private readonly pool: AgentPool,
    private readonly options: RouterOptions,
  ) {}

  async compile(request: CompileRequest): Promise<GatewayCompileResponse> {
    const { projectId, buildId } = request
    const lock = lockKey(projectId)
    // Le verrou est pris d'office ; l'ancienne valeur dit si une compilation était en cours.
    const previous = await this.redis.set(
      lock,
      buildId,
      'PX',
      request.timeoutMs + LOCK_MARGIN_MS,
      'GET',
    )
    try {
      // Toutes les demandes d'un projet vont au même agent (affinité posée atomiquement), qui
      // arrête lui-même la compilation en cours du projet et les exécute une par une.
      let agentId = await this.pickAgent(projectId)
      if (previous !== null) {
        // Une nouvelle demande arrête la précédente : l'arrêt attend la fin de son conteneur.
        this.options.logger.info({ projectId, buildId, previous }, 'stopping the previous compile')
        await this.stop(projectId)
      }
      let body: unknown
      try {
        body = await this.callCompile(agentId, request)
      } catch (error) {
        if (!(error instanceof AgentUnreachableError)) throw error
        // L'agent est tombé entre /health et la compilation : une autre tentative, à froid.
        this.options.logger.warn(
          { projectId, agentId },
          'agent unreachable, compiling on another agent',
        )
        agentId = await this.pickAgent(projectId, agentId)
        body = await this.callCompile(agentId, request)
      }
      await this.redis.set(affinityKey(projectId), agentId, 'EX', this.options.affinityTtlSeconds)
      return { ...agentCompileResponseSchema.parse(body), agentId }
    } finally {
      await this.redis.eval(RELEASE_LOCK, 1, lock, buildId)
    }
  }

  private callCompile(agentId: string, request: CompileRequest): Promise<unknown> {
    return this.pool.call(agentId, {
      method: 'POST',
      path: `/projects/${request.projectId}/compile`,
      body: request,
      timeoutMs: request.timeoutMs + AGENT_CALL_MARGIN_MS,
    })
  }

  /**
   * Agent de la compilation : celui de l'affinité s'il répond, sinon le moins chargé des agents
   * disponibles (compilation à froid), qui devient la nouvelle affinité.
   */
  async pickAgent(projectId: string, unreachable?: string): Promise<string> {
    const key = affinityKey(projectId)
    const current = await this.redis.get(key)
    if (
      current !== null &&
      current !== unreachable &&
      this.pool.has(current) &&
      (await this.pool.health(current)) !== null
    ) {
      return current
    }
    const excluded = new Set(
      [current, unreachable].filter((id): id is string => id !== null && id !== undefined),
    )
    const [best] = await this.pool.available(excluded)
    if (!best) throw new NoAgentAvailableError()
    const chosen = (await this.redis.eval(
      SWAP_AFFINITY,
      1,
      key,
      current ?? '',
      best.agentId,
      String(this.options.affinityTtlSeconds),
    )) as string
    if (chosen !== best.agentId) {
      this.options.logger.info({ projectId, chosen }, 'another request chose the agent first')
    } else if (current !== null) {
      this.options.logger.warn({ projectId, from: current, to: chosen }, 'agent affinity moved')
    }
    return chosen
  }

  private async affinity(projectId: string): Promise<string | null> {
    const agentId = await this.redis.get(affinityKey(projectId))
    return agentId !== null && this.pool.has(agentId) ? agentId : null
  }

  async stop(projectId: string): Promise<boolean> {
    const agentId = await this.affinity(projectId)
    if (agentId === null) return false
    try {
      const body = (await this.pool.call(agentId, {
        method: 'POST',
        path: `/projects/${projectId}/stop`,
        timeoutMs: STOP_TIMEOUT_MS,
      })) as { stopped?: unknown }
      return body.stopped === true
    } catch (error) {
      this.options.logger.warn({ err: error, projectId, agentId }, 'could not stop the compile')
      return false
    }
  }

  /** Le répertoire du projet peut exister sur plusieurs agents (après une bascule) : tous sont vidés. */
  async clearCache(projectId: string): Promise<boolean> {
    const results = await Promise.all(
      [...this.pool.agents.keys()].map(async (agentId) => {
        try {
          const body = (await this.pool.call(agentId, {
            method: 'POST',
            path: `/projects/${projectId}/clear-cache`,
            timeoutMs: STOP_TIMEOUT_MS,
          })) as { cleared?: unknown }
          return body.cleared === true
        } catch {
          return false
        }
      }),
    )
    return results.some(Boolean)
  }

  async synctexFromCode(projectId: string, query: SynctexCodeQuery): Promise<SynctexCodeResponse> {
    const params = new URLSearchParams({
      file: query.file,
      line: String(query.line),
      column: String(query.column),
    })
    return synctexCodeResponseSchema.parse(await this.synctex(projectId, 'code', params))
  }

  async synctexFromPdf(projectId: string, query: SynctexPdfQuery): Promise<SynctexPdfResponse> {
    const params = new URLSearchParams({
      page: String(query.page),
      h: String(query.h),
      v: String(query.v),
    })
    return synctexPdfResponseSchema.parse(await this.synctex(projectId, 'pdf', params))
  }

  /** SyncTeX lit le répertoire de la dernière compilation : même affinité que la compilation. */
  private async synctex(projectId: string, direction: 'code' | 'pdf', params: URLSearchParams) {
    const agentId = await this.affinity(projectId)
    if (agentId === null) throw new NoCompileOutputError()
    return this.pool.call(agentId, {
      method: 'GET',
      path: `/projects/${projectId}/synctex/${direction}?${params.toString()}`,
      timeoutMs: SYNCTEX_TIMEOUT_MS,
    })
  }
}
