#!/usr/bin/env node
// @ts-check
// Vérifie que la stack locale (docker compose) est prête : PostgreSQL, Redis, S3 et Mailpit.
// Usage : pnpm stack:check
import { execFileSync } from 'node:child_process'
import { connect } from 'node:net'

const WEB_ORIGIN = 'http://localhost:3000'
const BUCKETS = ['kaxolax-project-files', 'kaxolax-compile-outputs']

/** @param {string[]} args */
function compose(args) {
  return execFileSync('docker', ['compose', ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
}

/** @type {Array<[string, () => Promise<string>]>} */
const checks = [
  [
    'postgres',
    async () => {
      const databases = compose([
        'exec',
        '-T',
        'postgres',
        'psql',
        '-U',
        'kaxolax',
        '-d',
        'kaxolax',
        '-Atc',
        "select string_agg(datname, ',' order by datname) from pg_database where datname like 'kaxolax%'",
      ])
      if (databases !== 'kaxolax,kaxolax_test')
        throw new Error(`unexpected databases: ${databases}`)
      return 'kaxolax and kaxolax_test are reachable'
    },
  ],
  [
    'redis',
    async () => {
      const pong = compose(['exec', '-T', 'redis', 'redis-cli', 'ping'])
      if (pong !== 'PONG') throw new Error(`unexpected reply: ${pong}`)
      return 'PONG'
    },
  ],
  [
    's3',
    async () => {
      await waitForS3Init()
      const health = await fetch('http://127.0.0.1:8333/healthz')
      if (!health.ok) throw new Error(`healthz returned ${health.status}`)
      const listing = compose([
        'run',
        '--rm',
        '--no-deps',
        '--entrypoint',
        'aws',
        's3-init',
        '--endpoint-url',
        'http://s3:8333',
        's3api',
        'list-buckets',
        '--query',
        'Buckets[].Name',
        '--output',
        'text',
      ])
      for (const bucket of BUCKETS) {
        if (!listing.split(/\s+/).includes(bucket)) throw new Error(`missing bucket ${bucket}`)
        const preflight = await fetch(`http://127.0.0.1:8333/${bucket}/stack-check`, {
          method: 'OPTIONS',
          headers: {
            Origin: WEB_ORIGIN,
            'Access-Control-Request-Method': 'PUT',
            'Access-Control-Request-Headers': 'content-type',
          },
        })
        if (preflight.headers.get('access-control-allow-origin') !== WEB_ORIGIN) {
          throw new Error(`CORS preflight refused on ${bucket} (${preflight.status})`)
        }
      }
      return `${BUCKETS.join(', ')} exist, CORS allows ${WEB_ORIGIN}`
    },
  ],
  [
    'mailpit',
    async () => {
      const ready = await fetch('http://127.0.0.1:8025/readyz')
      if (!ready.ok) throw new Error(`readyz returned ${ready.status}`)
      const subject = `kaxolax stack check ${Date.now()}`
      await sendMail(subject)
      const search = await fetch(
        `http://127.0.0.1:8025/api/v1/search?query=${encodeURIComponent(`subject:"${subject}"`)}`,
      )
      const found = /** @type {{ messages: Array<{ ID: string }> }} */ (await search.json())
      if (found.messages.length !== 1) throw new Error('test email not received')
      await fetch('http://127.0.0.1:8025/api/v1/messages', {
        method: 'DELETE',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ IDs: found.messages.map((message) => message.ID) }),
      })
      return 'SMTP on 1025 delivers, UI on http://localhost:8025'
    },
  ],
]

/** Attend la fin du conteneur s3-init (création des buckets) et vérifie son code de sortie. */
async function waitForS3Init() {
  for (let attempt = 0; attempt < 60; attempt++) {
    const [state, exitCode] = compose([
      'ps',
      '-a',
      's3-init',
      '--format',
      '{{.State}} {{.ExitCode}}',
    ]).split(' ')
    if (state === 'exited') {
      if (exitCode !== '0') throw new Error(`s3-init exited with code ${exitCode}`)
      return
    }
    if (state === undefined || state === '') throw new Error('s3-init container not found')
    await new Promise((resolve) => setTimeout(resolve, 1000))
  }
  throw new Error('s3-init did not finish within 60 s')
}

/**
 * Envoie un email minimal en SMTP sur le port 1025.
 * @param {string} subject
 */
function sendMail(subject) {
  const commands = [
    'EHLO localhost',
    'MAIL FROM:<check@kaxolax.local>',
    'RCPT TO:<dev@kaxolax.local>',
    'DATA',
    `Subject: ${subject}\r\nFrom: check@kaxolax.local\r\nTo: dev@kaxolax.local\r\n\r\nok\r\n.`,
    'QUIT',
  ]
  return new Promise((resolve, reject) => {
    const socket = connect(1025, '127.0.0.1')
    socket.setTimeout(5000, () => socket.destroy(new Error('SMTP timeout')))
    socket.setEncoding('utf8')
    let buffer = ''
    socket.on('data', (chunk) => {
      buffer += chunk
      // Une réponse SMTP complète se termine par une ligne « 250 ... » (sans tiret après le code).
      const lines = buffer.split('\r\n').filter(Boolean)
      const last = lines.at(-1)
      if (!buffer.endsWith('\r\n') || last === undefined || last[3] === '-') return
      buffer = ''
      if (!/^[23]/.test(last)) return socket.destroy(new Error(`SMTP error: ${last}`))
      const next = commands.shift()
      if (next === undefined) return socket.end()
      socket.write(`${next}\r\n`)
    })
    socket.on('error', reject)
    socket.on('close', () => resolve(undefined))
  })
}

let failed = false
for (const [name, check] of checks) {
  try {
    console.log(`ok   ${name.padEnd(8)} ${await check()}`)
  } catch (error) {
    failed = true
    console.log(`FAIL ${name.padEnd(8)} ${error instanceof Error ? error.message : String(error)}`)
  }
}
if (failed) {
  console.log("\nLa stack locale n'est pas prête. Lance `docker compose up -d` puis réessaie.")
  process.exit(1)
}
