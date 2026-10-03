#!/usr/bin/env node
// @ts-check
// Smoke test des images de service construites depuis docker/Dockerfile. Chaque image démarre
// comme sur Railway : commande, sonde de santé et délai de deploy/railway/<service>.json, PORT
// injecté (8080, différent du port par défaut), migrations avant déploiement (`preDeployCommand`)
// pour l'API. Les images compile-gateway et compile-agent (hors Railway) démarrent avec leur CMD
// et répondent sur /health avec le jeton interne. Configuration : le .env.example de l'app, avec
// les hôtes de la pile docker compose, NODE_ENV=production, des secrets tirés au hasard et une
// base PostgreSQL temporaire (créée puis supprimée). Vérifie aussi l'utilisateur du processus
// (jamais root, sauf l'agent de compilation qui pilote Docker).
//
//   docker compose up -d --wait postgres redis s3 s3-init
//   node scripts/ci/service-smoke-test.mjs --tag <tag> web admin api realtime compile-gateway compile-agent
//
// Images attendues : kaxolax/<service>:<tag>. Node 24 et Docker ; aucune dépendance npm.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { parseArgs } from 'node:util'

const { values: args, positionals: services } = parseArgs({
  options: { tag: { type: 'string' } },
  allowPositionals: true,
})
if (args.tag === undefined || services.length === 0) {
  console.error('usage: service-smoke-test.mjs --tag <tag> <service>...')
  process.exit(2)
}
const TAG = args.tag

const ROOT = resolve(import.meta.dirname, '../..')
/** Port injecté par Railway (PORT) : différent des ports par défaut des images. */
const RAILWAY_PORT = 8080
const TOKEN_HEADER = 'x-internal-token'
/** Délai des migrations avant déploiement (preDeployCommand). */
const PRE_DEPLOY_TIMEOUT_MS = 5 * 60_000
/** Hôtes de la pile docker compose, par port local (.env.example). */
const STACK_HOSTS = /** @type {Record<string, string>} */ ({
  5432: 'postgres',
  6379: 'redis',
  8333: 's3',
  1025: 'mailpit',
})
const SECRETS = ['APP_KEY', 'REALTIME_TOKEN_SECRET', 'INTERNAL_TOKEN']

/**
 * @typedef {{
 *   stack: boolean,
 *   port?: number,
 *   authenticated?: boolean,
 *   root?: boolean,
 *   dockerSocket?: boolean,
 * }} ServiceOptions
 * @type {Record<string, ServiceOptions>}
 */
const SERVICES = {
  web: { stack: false },
  admin: { stack: false },
  api: { stack: true },
  realtime: { stack: true },
  'compile-gateway': { stack: true, port: 3100, authenticated: true },
  // Pilote les conteneurs de compilation : root et socket Docker, comme en développement.
  'compile-agent': { stack: true, port: 3200, authenticated: true, root: true, dockerSocket: true },
}
for (const service of services) {
  if (!Object.hasOwn(SERVICES, service)) {
    console.error(`unknown service: ${service}`)
    process.exit(2)
  }
}

/**
 * Lance `docker` et renvoie sa sortie standard ; une erreur si la commande échoue ou dépasse
 * `timeoutMs` (client tué : l'appelant supprime le conteneur qu'il a lancé).
 * @param {string[]} argv
 * @param {{ allowFailure?: boolean, timeoutMs?: number }} [options]
 */
function docker(argv, options = {}) {
  const result = spawnSync('docker', argv, {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: options.timeoutMs,
    killSignal: 'SIGKILL',
    maxBuffer: 16 * 1024 * 1024,
  })
  if (result.status !== 0 && options.allowFailure !== true) {
    const command = `docker ${argv.slice(0, 2).join(' ')}`
    const output = `${result.stdout}\n${result.stderr}`.trim().split('\n').slice(-80).join('\n')
    if (result.error !== undefined) {
      throw new Error(`${command}: ${result.error.message}:\n${output}`, { cause: result.error })
    }
    throw new Error(`${command} failed:\n${output}`)
  }
  return (result.stdout ?? '').trim()
}

/**
 * Variables d'un fichier .env (KEY=VALUE, commentaires ignorés).
 * @param {string} path
 */
function readEnvFile(path) {
  /** @type {Record<string, string>} */
  const env = {}
  if (!existsSync(path)) return env
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const match = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line.trim())
    if (match) env[match[1] ?? ''] = match[2] ?? ''
  }
  return env
}

/**
 * Commande Railway (chaîne ou liste) en arguments, sans shell.
 * @param {unknown} command
 * @returns {string[] | null}
 */
function commandArgs(command) {
  if (typeof command === 'string') return command.trim().split(/\s+/)
  if (Array.isArray(command)) return command.map(String)
  return null
}

/**
 * Démarrage d'un service : celui de Railway quand il y est déployé.
 * @param {string} service
 * @param {ServiceOptions} options
 * @param {Record<string, string>} env
 */
function startup(service, options, env) {
  const path = join(ROOT, 'deploy/railway', `${service}.json`)
  if (!existsSync(path)) {
    return {
      railway: false,
      command: [],
      preDeploy: null,
      port: options.port ?? Number(env.PORT),
      health: '/health',
      timeoutMs: 60_000,
    }
  }
  /** @type {{ deploy?: Record<string, unknown> }} */
  const railway = JSON.parse(readFileSync(path, 'utf8'))
  const deploy = railway.deploy ?? {}
  const command = commandArgs(deploy.startCommand)
  assert.ok(command !== null, `${path}: deploy.startCommand`)
  assert.equal(typeof deploy.healthcheckPath, 'string', `${path}: deploy.healthcheckPath`)
  return {
    railway: true,
    command,
    preDeploy: commandArgs(deploy.preDeployCommand),
    port: RAILWAY_PORT,
    health: /** @type {string} */ (deploy.healthcheckPath),
    timeoutMs: Number(deploy.healthcheckTimeout ?? 60) * 1000,
  }
}

/**
 * Configuration du conteneur : .env.example de l'app adapté à la pile docker compose.
 * @param {string} service
 * @param {string} database
 * @param {Record<string, string>} secrets
 */
function environment(service, database, secrets) {
  const env = readEnvFile(join(ROOT, 'apps', service, '.env.example'))
  for (const [key, value] of Object.entries(env)) {
    env[key] = value.replace(
      /\b(?:127\.0\.0\.1|localhost):(5432|6379|8333|1025)\b/g,
      (_match, /** @type {string} */ port) => `${STACK_HOSTS[port] ?? ''}:${port}`,
    )
  }
  if ('NODE_ENV' in env) env.NODE_ENV = 'production'
  if ('HOST' in env) env.HOST = '0.0.0.0'
  if ('DB_HOST' in env) env.DB_HOST = 'postgres'
  if ('DB_DATABASE' in env) env.DB_DATABASE = database
  if ('SMTP_HOST' in env) env.SMTP_HOST = 'mailpit'
  if ('REDIS_URL' in env) env.REDIS_URL = 'redis://redis:6379'
  if (env.DATABASE_URL !== undefined) {
    const url = new URL(env.DATABASE_URL)
    url.hostname = 'postgres'
    url.pathname = `/${database}`
    env.DATABASE_URL = url.toString()
  }
  for (const key of SECRETS) if (key in env) env[key] = secrets[key] ?? ''
  return env
}

/** Réseau de la pile docker compose (celui du conteneur postgres). */
function stackNetwork() {
  const id = docker(['compose', 'ps', '--quiet', 'postgres'])
  assert.ok(id !== '', 'docker compose stack is not running (postgres)')
  const networks = docker(['inspect', '--format', '{{json .NetworkSettings.Networks}}', id])
  const name = Object.keys(JSON.parse(networks))[0]
  assert.ok(name !== undefined, 'network of the docker compose stack')
  return name
}

/** @param {string} sql */
function psql(sql) {
  docker(
    [
      'compose',
      'exec',
      '-T',
      'postgres',
      'psql',
      '-U',
      'kaxolax',
      '-d',
      'kaxolax',
      '-X',
      '-q',
      '-v',
      'ON_ERROR_STOP=1',
      '-c',
      sql,
    ],
    { timeoutMs: 60_000 },
  )
}

/**
 * Attend que la sonde de santé réponde 200 (le conteneur doit rester en vie).
 * @param {string} name
 * @param {string} url
 * @param {Record<string, string>} headers
 * @param {number} timeoutMs
 */
async function waitHealthy(name, url, headers, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  let last = 'no answer'
  while (Date.now() < deadline) {
    if (docker(['inspect', '--format', '{{.State.Running}}', name]) !== 'true') {
      throw new Error(
        `container exited:\n${docker(['logs', '--tail', '80', name], { allowFailure: true })}`,
      )
    }
    try {
      const response = await fetch(url, { headers, signal: AbortSignal.timeout(5_000) })
      if (response.status === 200) return
      last = `HTTP ${String(response.status)}`
    } catch (error) {
      last = String(error)
    }
    await sleep(1_000)
  }
  throw new Error(
    `${url}: ${last} after ${String(timeoutMs / 1000)} s:\n${docker(['logs', '--tail', '80', name], { allowFailure: true })}`,
  )
}

const suffix = randomBytes(4).toString('hex')
const scratch = mkdtempSync(join(tmpdir(), 'kx-smoke-'))
const database = `kaxolax_smoke_${suffix}`
const needsStack = services.some((service) => SERVICES[service]?.stack === true)
let failures = 0
let databaseCreated = false
try {
  const network = needsStack ? stackNetwork() : null
  if (needsStack) {
    psql(`CREATE DATABASE ${database}`)
    databaseCreated = true
  }
  /** @type {Record<string, string>} */
  const secrets = Object.fromEntries(SECRETS.map((key) => [key, randomBytes(32).toString('hex')]))

  for (const service of services) {
    const options = SERVICES[service] ?? { stack: false }
    const image = `kaxolax/${service}:${TAG}`
    const name = `kx-smoke-${service}-${suffix}`
    const started = performance.now()
    try {
      const env = environment(service, database, secrets)
      const run = startup(service, options, env)
      if (run.railway) env.PORT = String(RAILWAY_PORT)
      const envFile = join(scratch, `${service}.env`)
      writeFileSync(
        envFile,
        Object.entries(env)
          .map(([key, value]) => `${key}=${value}`)
          .join('\n'),
        { mode: 0o600 },
      )
      const common = [
        '--env-file',
        envFile,
        ...(network !== null && options.stack ? ['--network', network] : []),
        ...(options.dockerSocket === true
          ? ['--volume', '/var/run/docker.sock:/var/run/docker.sock']
          : []),
      ]
      if (run.preDeploy !== null) {
        // Migrations : une commande bloquée échoue ici, avec sa sortie, plutôt qu'au délai du job.
        try {
          docker(
            ['run', '--rm', '--name', `${name}-predeploy`, ...common, image, ...run.preDeploy],
            {
              timeoutMs: PRE_DEPLOY_TIMEOUT_MS,
            },
          )
        } finally {
          docker(['rm', '--force', `${name}-predeploy`], { allowFailure: true })
        }
      }
      docker([
        'run',
        '--detach',
        '--name',
        name,
        '--publish',
        `127.0.0.1::${String(run.port)}`,
        ...common,
        image,
        ...run.command,
      ])
      const address = docker(['port', name, `${String(run.port)}/tcp`]).split('\n')[0] ?? ''
      /** @type {Record<string, string>} */
      const headers =
        options.authenticated === true ? { [TOKEN_HEADER]: secrets.INTERNAL_TOKEN ?? '' } : {}
      await waitHealthy(name, `http://${address}${run.health}`, headers, run.timeoutMs)
      const uid = docker(['exec', name, 'id', '-u'])
      if (options.root === true) assert.equal(uid, '0', 'user')
      else assert.notEqual(uid, '0', 'the service must not run as root')
      const seconds = ((performance.now() - started) / 1000).toFixed(1)
      console.log(`ok - ${service}: ${run.health} answered 200 (uid ${uid}, ${seconds} s)`)
    } catch (error) {
      failures++
      console.log(`not ok - ${service}`)
      console.log(`  ${String(error instanceof Error ? error.message : error)}`)
    } finally {
      docker(['rm', '--force', name], { allowFailure: true })
    }
  }
} finally {
  // Nettoyage au mieux : un échec ici (postgres arrêté…) ne masque ni l'erreur ni le bilan.
  if (databaseCreated) {
    try {
      psql(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`)
    } catch (error) {
      console.log(
        `# could not drop ${database}: ${String(error instanceof Error ? error.message : error)}`,
      )
    }
  }
  rmSync(scratch, { recursive: true, force: true })
}
console.log(`# ${String(services.length - failures)}/${String(services.length)} passed`)
process.exit(failures === 0 ? 0 : 1)
