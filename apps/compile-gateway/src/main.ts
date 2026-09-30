import { Redis } from 'ioredis'
import { pino } from 'pino'
import { AgentPool } from './agents.js'
import { loadConfig } from './config.js'
import { CompileRouter } from './router.js'
import { buildServer } from './server.js'

const config = loadConfig()
const logger = pino({ name: 'compile-gateway', level: config.LOG_LEVEL })
const redis = new Redis(config.REDIS_URL, { maxRetriesPerRequest: 3 })
const pool = new AgentPool(
  config.COMPILE_AGENTS,
  config.INTERNAL_TOKEN,
  config.AGENT_HEALTH_TIMEOUT_MS,
)
const router = new CompileRouter(redis, pool, {
  affinityTtlSeconds: config.AFFINITY_TTL_SECONDS,
  logger,
})
const server = buildServer({ router, pool, internalToken: config.INTERNAL_TOKEN, logger })

await server.listen({ host: config.HOST, port: config.PORT })
logger.info({ agents: [...config.COMPILE_AGENTS.keys()] }, 'compile gateway ready')

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    logger.info({ signal }, 'shutting down')
    void server
      .close()
      .then(() => redis.quit())
      .then(() => process.exit(0))
  })
}
