import { type AgentHealth, agentHealthSchema, INTERNAL_TOKEN_HEADER } from '@kaxolax/contracts'

/** L'agent n'a pas pu être joint (connexion refusée, coupée, délai dépassé) : il est indisponible. */
export class AgentUnreachableError extends Error {
  constructor(
    readonly agentId: string,
    cause: unknown,
  ) {
    super(`Agent ${agentId} is unreachable`, { cause })
    this.name = 'AgentUnreachableError'
  }
}

/** L'agent a répondu avec une erreur HTTP : on relaie son statut et son corps. */
export class AgentResponseError extends Error {
  constructor(
    readonly agentId: string,
    readonly status: number,
    readonly body: unknown,
  ) {
    super(`Agent ${agentId} answered ${String(status)}`)
    this.name = 'AgentResponseError'
  }
}

export interface AgentRequest {
  method: 'GET' | 'POST'
  path: string
  body?: unknown
  timeoutMs: number
}

/** Appels HTTP vers les agents de compilation, authentifiés par X-Internal-Token. */
export class AgentPool {
  constructor(
    readonly agents: ReadonlyMap<string, string>,
    private readonly internalToken: string,
    private readonly healthTimeoutMs: number,
  ) {}

  has(agentId: string): boolean {
    return this.agents.has(agentId)
  }

  async call(agentId: string, request: AgentRequest): Promise<unknown> {
    const base = this.agents.get(agentId)
    if (base === undefined) throw new AgentUnreachableError(agentId, new Error('unknown agent'))
    let response: Response
    try {
      response = await fetch(`${base}${request.path}`, {
        method: request.method,
        headers: {
          [INTERNAL_TOKEN_HEADER]: this.internalToken,
          ...(request.body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        body: request.body === undefined ? undefined : JSON.stringify(request.body),
        signal: AbortSignal.timeout(request.timeoutMs),
      })
    } catch (error) {
      throw new AgentUnreachableError(agentId, error)
    }
    const body: unknown = await response.json().catch(() => null)
    if (!response.ok) throw new AgentResponseError(agentId, response.status, body)
    return body
  }

  /** État d'un agent, ou null s'il ne répond pas à temps. */
  async health(agentId: string): Promise<AgentHealth | null> {
    try {
      const body = await this.call(agentId, {
        method: 'GET',
        path: '/health',
        timeoutMs: this.healthTimeoutMs,
      })
      return agentHealthSchema.parse(body)
    } catch {
      return null
    }
  }

  /** Agents disponibles, du moins chargé au plus chargé (compilations actives / capacité). */
  async available(except: ReadonlySet<string> = new Set()): Promise<AgentHealth[]> {
    const ids = [...this.agents.keys()].filter((id) => !except.has(id))
    const states = await Promise.all(ids.map(async (id) => ({ id, health: await this.health(id) })))
    return states
      .flatMap(({ id, health }) => (health ? [{ ...health, agentId: id }] : []))
      .sort((a, b) => a.activeCompiles / a.capacity - b.activeCompiles / b.capacity)
  }
}
