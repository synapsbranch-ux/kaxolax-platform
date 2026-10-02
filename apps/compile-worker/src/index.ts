import type { Env } from './env.js'
import { handleRequest } from './router.js'

export { CompileContainer } from './container.js'

/** Worker de compilation : authentifie l'API puis s'adresse au Durable Object du projet. */
export default {
  async fetch(request, env): Promise<Response> {
    return handleRequest(request, {
      secret: env.COMPILE_WORKER_SECRET,
      compilerFor: (projectId) => {
        const stub = env.COMPILER.getByName(projectId)
        return {
          enqueue: (job) => stub.enqueue(job),
          cancel: (buildId) => stub.cancel(buildId),
          warm: () => stub.warm(projectId),
          clearCache: () => stub.clearCache(),
          synctex: (kind, query, buildId) => stub.synctex(kind, query, buildId),
          wordCount: (request) => stub.wordCount(request),
        }
      },
      log: (message, data) => {
        console.log(JSON.stringify({ message, ...data }))
      },
    })
  },
} satisfies ExportedHandler<Env>
