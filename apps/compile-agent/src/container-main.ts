import { mkdir, writeFile } from 'node:fs/promises'
import { pino } from 'pino'
import { Compiler } from './compiler.js'
import { loadContainerConfig } from './container-config.js'
import { buildContainerServer } from './container-server.js'
import { ProcessSandbox } from './process-sandbox.js'
import { BinaryCache, LocalOutputStore } from './storage.js'

/**
 * Point d'entrée de l'agent dans le conteneur Cloudflare (image apps/compile-worker/container).
 * L'agent tourne en root dans la VM ; les compilations, en UID 1000 confiné (ProcessSandbox).
 */
const config = loadContainerConfig()
const logger = pino({ level: config.LOG_LEVEL, base: { agentId: config.AGENT_ID } })

await mkdir(config.COMPILES_DIR, { recursive: true, mode: 0o711 })
await mkdir(config.CACHE_DIR, { recursive: true, mode: 0o700 })
await mkdir(config.OUTPUTS_DIR, { recursive: true, mode: 0o700 })
// Si la mémoire de la VM s'épuise, le noyau tue la compilation (score 1000), pas l'agent.
await writeFile('/proc/self/oom_score_adj', '-900').catch(() => undefined)

const cache = new BinaryCache(config.CACHE_DIR, (s3Key) =>
  Promise.reject(new Error(`Binary not pushed by the worker: ${s3Key}`)),
)
const compiler = new Compiler({
  agentId: config.AGENT_ID,
  compilesDir: config.COMPILES_DIR,
  // Une instance par projet : une compilation à la fois.
  capacity: 1,
  workdirMaxBytes: config.WORKDIR_MAX_BYTES,
  outputBucket: config.OUTPUT_BUCKET,
  sandbox: new ProcessSandbox({
    uid: config.SANDBOX_UID,
    gid: config.SANDBOX_GID,
    tmpDir: config.SANDBOX_TMP_DIR,
    path: config.SANDBOX_PATH,
    extraEnv: Object.fromEntries(
      config.SANDBOX_ENV_PASSTHROUGH.flatMap((name) => {
        const value = process.env[name]
        return value === undefined || name === 'INTERNAL_TOKEN' ? [] : [[name, value]]
      }),
    ),
  }),
  binaries: cache,
  outputs: new LocalOutputStore(config.OUTPUTS_DIR),
  logger,
  uploadSynctex: true,
})
const server = buildContainerServer({
  compiler,
  cache,
  outputsDir: config.OUTPUTS_DIR,
  outputBucket: config.OUTPUT_BUCKET,
  internalToken: config.INTERNAL_TOKEN,
  logger,
})

const timer = setInterval(() => {
  cache.prune(config.CACHE_MAX_BYTES).catch((error: unknown) => {
    logger.error(error, 'cache cleanup failed')
  })
}, 5 * 60_000)
timer.unref()

await server.listen({ host: config.HOST, port: config.PORT })
logger.info('compile container ready')

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    logger.info({ signal }, 'shutting down')
    clearInterval(timer)
    void server.close().then(() => process.exit(0))
  })
}
