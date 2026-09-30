import { mkdir } from 'node:fs/promises'

import { type Logger, pino } from 'pino'
import { pruneProjects } from './cleanup.js'
import { Compiler } from './compiler.js'
import { type AgentConfig } from './config.js'
import { DockerClient } from './docker.js'
import { Sandbox } from './sandbox.js'
import { buildServer } from './server.js'
import {
  BinaryCache,
  createS3Client,
  type OutputStore,
  S3OutputStore,
  s3Fetcher,
} from './storage.js'
import { type BinarySource } from './workspace.js'

const CLEANUP_INTERVAL_MS = 5 * 60_000

export interface Agent {
  compiler: Compiler
  server: ReturnType<typeof buildServer>
  docker: DockerClient
  cache: BinaryCache
  logger: Logger
  cleanup(): Promise<void>
  close(): Promise<void>
}

export interface AgentOverrides {
  outputs?: OutputStore
  binaries?: BinarySource
  logger?: Logger
}

export async function createAgent(
  config: AgentConfig,
  overrides: AgentOverrides = {},
): Promise<Agent> {
  await mkdir(config.COMPILES_DIR, { recursive: true, mode: 0o700 })
  await mkdir(config.CACHE_DIR, { recursive: true, mode: 0o700 })
  const logger =
    overrides.logger ?? pino({ level: config.LOG_LEVEL, base: { agentId: config.AGENT_ID } })
  const docker = new DockerClient(config.DOCKER_SOCKET)
  const s3 = createS3Client(config)
  const cache = new BinaryCache(config.CACHE_DIR, s3Fetcher(s3, config.S3_BUCKET_PROJECT_FILES))
  const compiler = new Compiler({
    agentId: config.AGENT_ID,
    compilesDir: config.COMPILES_DIR,
    capacity: config.MAX_CONCURRENT_COMPILES,
    workdirMaxBytes: config.WORKDIR_MAX_BYTES,
    outputBucket: config.S3_BUCKET_COMPILE_OUTPUTS,
    sandbox: new Sandbox(docker, { image: config.COMPILE_IMAGE, runtime: config.COMPILE_RUNTIME }),
    binaries: overrides.binaries ?? cache,
    outputs: overrides.outputs ?? new S3OutputStore(s3),
    logger,
  })
  const server = buildServer({ compiler, internalToken: config.INTERNAL_TOKEN, logger })

  const cleanup = async () => {
    const projects = await pruneProjects(
      config.COMPILES_DIR,
      { maxProjects: config.COMPILES_MAX_PROJECTS, maxBytes: config.COMPILES_MAX_BYTES },
      (projectId) => compiler.isCompiling(projectId),
    )
    const binaries = await cache.prune(config.CACHE_MAX_BYTES)
    if (projects.removed.length > 0 || binaries > 0) {
      logger.info(
        { projects: projects.removed.length, binaries },
        'cleanup removed least recently used entries',
      )
    }
  }
  const timer = setInterval(() => {
    cleanup().catch((error: unknown) => {
      logger.error(error, 'cleanup failed')
    })
  }, CLEANUP_INTERVAL_MS)
  timer.unref()

  return {
    compiler,
    server,
    docker,
    cache,
    logger,
    cleanup,
    close: async () => {
      clearInterval(timer)
      await server.close()
      s3.destroy()
    },
  }
}
