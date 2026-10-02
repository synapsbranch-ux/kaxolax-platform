import { randomUUID } from 'node:crypto'
import { projectEventMessageSchema } from '@kaxolax/contracts'
import { Redis } from 'ioredis'
import type { Logger } from 'pino'
import { z } from 'zod'
import type { MemberChange, MemberChangeFanout } from './access.js'

/**
 * Relais entre instances du service temps réel. L'extension Redis de Hocuspocus synchronise les
 * documents, l'awareness et les messages sans état des documents chargés ; ce bus relaie le reste,
 * qui ne dépend pas d'un document chargé : changements de membres, fermeture des connexions d'un
 * compte, événements du projet publiés par l'API. Il relaie aussi le départ d'une connexion
 * (`awareness-departed`), que l'extension Redis ne transmet pas : sans lui, sa présence resterait
 * jusqu'à 30 s sur les autres instances. L'instance appelée par l'API applique l'effet
 * chez elle puis le publie ; les autres l'appliquent à la réception.
 */

const uuid = z.uuid()

export const clusterMessageSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('member-changed'), projectId: uuid, userId: uuid }),
  z.object({ kind: z.literal('user-disconnect'), userId: uuid }),
  z.object({ kind: z.literal('document-close'), documentId: uuid }),
  /** Connexion fermée : clientIds Yjs dont la présence doit disparaître du document. */
  z.object({
    kind: z.literal('awareness-departed'),
    documentName: z.string().min(1).max(200),
    clientIds: z.array(z.number().int().nonnegative()).min(1).max(1000),
  }),
  /** `projectId` null : à tous les documents meta (bannière). */
  z.object({
    kind: z.literal('project-event'),
    projectId: uuid.nullable(),
    message: projectEventMessageSchema,
  }),
])
export type ClusterMessage = z.infer<typeof clusterMessageSchema>

export interface ClusterBus {
  /** Envoie aux autres instances (jamais à soi-même). */
  publish(message: ClusterMessage): Promise<void>
  subscribe(listener: (message: ClusterMessage) => Promise<void>): void
  /** Résolu une fois l'abonnement actif : avant, les messages des autres instances sont perdus. */
  ready(): Promise<void>
  close(): Promise<void>
}

/** Une seule instance : rien à relayer. */
export const singleInstanceBus: ClusterBus = {
  publish: () => Promise.resolve(),
  subscribe: () => undefined,
  ready: () => Promise.resolve(),
  close: () => Promise.resolve(),
}

/** `MemberChangeFanout` (voir `access.ts`) porté par le bus. */
export function memberChangeFanout(bus: ClusterBus): MemberChangeFanout {
  return {
    publish: (change: MemberChange) => bus.publish({ kind: 'member-changed', ...change }),
    subscribe: (listener) => {
      bus.subscribe(async (message) => {
        if (message.kind === 'member-changed') {
          await listener({ projectId: message.projectId, userId: message.userId })
        }
      })
    },
  }
}

/** Enveloppe publiée sur Redis : l'identifiant de l'émetteur, pour ignorer ses propres messages. */
const envelopeSchema = z.object({ from: z.string().min(1), message: z.unknown() })

/**
 * Bus Redis pub/sub : une connexion pour publier, une pour l'abonnement (une connexion abonnée ne
 * peut plus publier). Un message invalide est journalisé et ignoré.
 */
export class RedisClusterBus implements ClusterBus {
  readonly identifier = `realtime-${randomUUID()}`
  private readonly listeners: ((message: ClusterMessage) => Promise<void>)[] = []
  private readonly pub: Redis
  private readonly sub: Redis
  private readonly subscribed: Promise<void>

  constructor(
    url: string,
    private readonly channel: string,
    private readonly logger: Logger,
  ) {
    this.pub = new Redis(url, { lazyConnect: false })
    this.sub = new Redis(url, { lazyConnect: false })
    for (const client of [this.pub, this.sub]) {
      client.on('error', (error: unknown) => {
        this.logger.error({ err: error }, 'redis cluster bus error')
      })
    }
    this.sub.on('message', (channel: string, raw: string) => {
      if (channel === this.channel) void this.receive(raw)
    })
    this.subscribed = this.sub.subscribe(this.channel).then(() => undefined)
    // L'erreur est rendue à qui attend `ready()` ; ce gestionnaire évite un rejet non géré.
    this.subscribed.catch(() => undefined)
  }

  ready(): Promise<void> {
    return this.subscribed
  }

  async publish(message: ClusterMessage): Promise<void> {
    await this.pub.publish(this.channel, JSON.stringify({ from: this.identifier, message }))
  }

  subscribe(listener: (message: ClusterMessage) => Promise<void>): void {
    this.listeners.push(listener)
  }

  private async receive(raw: string): Promise<void> {
    let message: ClusterMessage
    try {
      const envelope = envelopeSchema.parse(JSON.parse(raw))
      if (envelope.from === this.identifier) return
      message = clusterMessageSchema.parse(envelope.message)
    } catch (error) {
      this.logger.warn({ err: error }, 'invalid cluster message ignored')
      return
    }
    for (const listener of this.listeners) {
      try {
        await listener(message)
      } catch (error) {
        this.logger.error({ err: error, kind: message.kind }, 'cluster message handling failed')
      }
    }
  }

  async close(): Promise<void> {
    await Promise.allSettled([this.sub.quit(), this.pub.quit()])
  }
}

/** Options de connexion de l'extension Redis de Hocuspocus, tirées de `REDIS_URL`. */
export function redisConnectionOptions(url: string) {
  const parsed = new URL(url)
  if (parsed.protocol !== 'redis:' && parsed.protocol !== 'rediss:') {
    throw new Error('REDIS_URL must use the redis:// or rediss:// scheme')
  }
  const db = parsed.pathname.replace(/^\//, '')
  return {
    host: parsed.hostname,
    port: parsed.port === '' ? 6379 : Number(parsed.port),
    options: {
      ...(parsed.username === '' ? {} : { username: decodeURIComponent(parsed.username) }),
      ...(parsed.password === '' ? {} : { password: decodeURIComponent(parsed.password) }),
      ...(db === '' ? {} : { db: Number(db) }),
      ...(parsed.protocol === 'rediss:' ? { tls: {} } : {}),
    },
  }
}
