#!/usr/bin/env node
/**
 * Ligne de commande de l'agent : compile un dossier local sans interface, sans S3 ni HTTP.
 *
 *   kaxolax-compile compile ./examples/demo --compiler pdflatex --repeat 2
 *   kaxolax-compile synctex-code ./examples/demo --file chapters/intro.tex --line 3
 *   kaxolax-compile synctex-pdf ./examples/demo --page 1 --h 150 --v 200
 *   kaxolax-compile clear-cache ./examples/demo
 */
import { randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import {
  type CompileRequest,
  type CompileResource,
  compileOutputPrefix,
  compilerSchema,
  DEFAULT_COMPILE_TIMEOUT_MS,
  isTextDocument,
  projectFilesPrefix,
} from '@kaxolax/contracts'
import { pino } from 'pino'
import { Compiler } from './compiler.js'
import { DockerClient } from './docker.js'
import { Sandbox } from './sandbox.js'
import { BinaryCache, LocalOutputStore } from './storage.js'
import { sha256Hex } from './workspace.js'

const LOCAL_BUCKET = 'local-outputs'

/** Identifiant de projet stable pour un dossier (même dossier, même répertoire de travail). */
function projectIdFor(directory: string): string {
  const hex = sha256Hex(resolve(directory)).slice(0, 32).split('')
  hex[12] = '4'
  hex[16] = ((Number.parseInt(hex[16] ?? '0', 16) & 0x3) | 0x8).toString(16)
  const value = hex.join('')
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`
}

async function listFiles(directory: string, base = directory): Promise<string[]> {
  const files: string[] = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) files.push(...(await listFiles(path, base)))
    else if (entry.isFile()) files.push(relative(base, path).split('\\').join('/'))
  }
  return files.sort()
}

async function buildResources(
  directory: string,
  projectId: string,
  localFiles: Map<string, string>,
) {
  const resources: CompileResource[] = []
  for (const path of await listFiles(directory)) {
    const bytes = await readFile(join(directory, path))
    const sha256 = sha256Hex(bytes)
    if (isTextDocument(path, bytes)) {
      resources.push({ path, kind: 'text', content: new TextDecoder().decode(bytes), sha256 })
    } else {
      const s3Key = `${projectFilesPrefix(projectId)}local/${path}`
      localFiles.set(s3Key, join(directory, path))
      resources.push({ path, kind: 'binary', s3Key, sha256 })
    }
  }
  return resources
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      compiler: { type: 'string', default: 'pdflatex' },
      main: { type: 'string', default: 'main.tex' },
      timeout: { type: 'string', default: String(DEFAULT_COMPILE_TIMEOUT_MS) },
      repeat: { type: 'string', default: '1' },
      out: { type: 'string', default: '.data/outputs' },
      file: { type: 'string' },
      line: { type: 'string' },
      column: { type: 'string', default: '0' },
      page: { type: 'string' },
      h: { type: 'string' },
      v: { type: 'string' },
    },
  })
  const [command, directoryArgument] = positionals
  if (command === undefined || directoryArgument === undefined) {
    console.error(
      'usage: kaxolax-compile <compile|synctex-code|synctex-pdf|clear-cache> <dir> [options]',
    )
    process.exit(2)
  }
  const directory = resolve(directoryArgument)
  const projectId = projectIdFor(directory)
  const localFiles = new Map<string, string>()
  const env = process.env
  const image = env.COMPILE_IMAGE ?? 'kaxolax-texlive:2026-medium'
  const runtime = env.COMPILE_RUNTIME === 'runsc' ? 'runsc' : 'runc'
  const cache = new BinaryCache(resolve(env.CACHE_DIR ?? '.data/cache'), (s3Key) => {
    const path = localFiles.get(s3Key)
    if (path === undefined) throw new Error(`Unknown local file: ${s3Key}`)
    return Promise.resolve(createReadStream(path))
  })
  const compiler = new Compiler({
    agentId: 'cli',
    compilesDir: resolve(env.COMPILES_DIR ?? '.data/compiles'),
    capacity: 1,
    workdirMaxBytes: 2 * 1024 * 1024 * 1024,
    outputBucket: LOCAL_BUCKET,
    sandbox: new Sandbox(new DockerClient(env.DOCKER_SOCKET ?? '/var/run/docker.sock'), {
      image,
      runtime,
    }),
    binaries: cache,
    outputs: new LocalOutputStore(resolve(values.out)),
    logger: pino({ level: env.LOG_LEVEL ?? 'warn' }),
  })

  if (command === 'compile') {
    const durations: number[] = []
    for (let attempt = 1; attempt <= Number(values.repeat); attempt++) {
      const buildId = randomUUID()
      const request: CompileRequest = {
        projectId,
        buildId,
        compiler: compilerSchema.parse(values.compiler),
        rootResourcePath: values.main,
        timeoutMs: Number(values.timeout),
        resources: await buildResources(directory, projectId, localFiles),
        output: { bucket: LOCAL_BUCKET, prefix: compileOutputPrefix(projectId, buildId) },
      }
      const result = await compiler.compile(request)
      durations.push(result.durationMs)
      const { syncMs, runMs, uploadMs } = result.timings
      console.log(
        `#${String(attempt)} ${result.status} in ${String(result.durationMs)} ms ` +
          `(sync ${String(syncMs)} ms, run ${String(runMs)} ms, upload ${String(uploadMs)} ms)`,
      )
      for (const entry of result.entries) {
        const where =
          entry.file === null
            ? ''
            : `${entry.file}${entry.line === null ? '' : `:${String(entry.line)}`} `
        console.log(`  ${entry.level.padEnd(11)} ${where}${entry.message}`)
      }
      for (const file of result.outputFiles) {
        console.log(
          `  → ${join(resolve(values.out), LOCAL_BUCKET, file.s3Key)} (${String(file.sizeBytes)} bytes)`,
        )
      }
    }
    if (durations.length > 1) {
      console.log(
        `cold ${String(durations[0])} ms, then ${durations.slice(1).map(String).join(' ms, ')} ms`,
      )
    }
  } else if (command === 'synctex-code') {
    const result = await compiler.synctexFromCode(projectId, {
      file: values.file ?? values.main,
      line: Number(values.line ?? '1'),
      column: Number(values.column),
    })
    console.log(JSON.stringify(result, null, 2))
  } else if (command === 'synctex-pdf') {
    const result = await compiler.synctexFromPdf(projectId, {
      page: Number(values.page ?? '1'),
      h: Number(values.h ?? '0'),
      v: Number(values.v ?? '0'),
    })
    console.log(JSON.stringify(result, null, 2))
  } else if (command === 'clear-cache') {
    console.log(JSON.stringify({ cleared: await compiler.clearCache(projectId) }))
  } else {
    console.error(`unknown command: ${command}`)
    process.exit(2)
  }
}

await main()
