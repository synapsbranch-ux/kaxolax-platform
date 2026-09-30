import { pino } from 'pino'
import { loadConfig } from './config.js'
import { createRealtimeServer } from './server.js'
import { DocumentStore } from './store.js'

const config = loadConfig()
const logger = pino({ name: 'realtime', level: config.LOG_LEVEL })
const store = DocumentStore.connect(config.DATABASE_URL, config.DB_SSL)
const server = createRealtimeServer(config, store, logger)

await server.listen()
logger.info({ host: config.HOST, port: server.address.port }, 'realtime service listening')

let stopping = false
async function shutdown(signal: string): Promise<void> {
  if (stopping) return
  stopping = true
  logger.info({ signal }, 'shutting down')
  // destroy() ferme les connexions et enregistre les documents en attente avant de rendre la main.
  await server.destroy()
  await store.close()
  process.exit(0)
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => void shutdown(signal))
}
