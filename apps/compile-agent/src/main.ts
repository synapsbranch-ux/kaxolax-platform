import { createAgent } from './agent.js'
import { loadConfig } from './config.js'

const config = loadConfig()
const agent = await createAgent(config)

await agent.docker.ping()
if (!(await agent.docker.imageExists(config.COMPILE_IMAGE))) {
  agent.logger.warn(
    { image: config.COMPILE_IMAGE },
    'compile image not found locally: compiles will fail',
  )
}
await agent.cleanup()
await agent.server.listen({ host: config.HOST, port: config.PORT })
agent.logger.info(
  { runtime: config.COMPILE_RUNTIME, image: config.COMPILE_IMAGE },
  'compile agent ready',
)

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    agent.logger.info({ signal }, 'shutting down')
    void agent.close().then(() => process.exit(0))
  })
}
