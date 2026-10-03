#!/usr/bin/env node
// @ts-check
// Test du conteneur de compilation Cloudflare (apps/compile-worker/container/Dockerfile), lancé comme
// en production : sans accès réseau (réseau Docker interne, `enableInternet = false` chez
// Cloudflare) et piloté par son API HTTP comme le fait le Worker (apps/compile-worker/src/runner.ts) :
// jeton interne, binaires manquants poussés, compilation, sorties relues puis supprimées. Vérifie :
// - une vraie compilation pdfLaTeX (BibTeX, image, \input) : PDF, log et SyncTeX produits, SyncTeX
//   dans les deux sens et restauré après recyclage, comptage de mots, cache des binaires ;
// - qu'un \input hors du dossier du projet (fichier réservé à root, environnement de l'agent qui
//   contient le jeton interne) échoue sans rien divulguer ;
// - la suite malveillante de kaxolax-texlive-images (/usr/share/kaxolax/malicious dans l'image TeX
//   Live), avec les attentes de apps/compile-agent/test/integration/malicious.test.ts. L'« hôte »
//   est ici la VM : le fichier témoin est un fichier réservé à root dans le conteneur ;
// - la conversion Markdown → LaTeX (pandoc) : Markdown riche converti puis compilé, et cas
//   malveillants `convert` de la suite (attentes de apps/compile-agent/test/integration/convert.test.ts).
//   Ignorée (# SKIP) si l'image TeX Live n'a pas pandoc.
//
//   node scripts/ci/container-compile-test.mjs --image <image> [--cases <dossier>] [--only <cas>]
//
// --cases : dossier des cas malveillants, pour une image de base qui ne les embarque pas.
// --only : ne rejoue que ces cas malveillants (option répétable).
// Node 24 et Docker ; aucune dépendance npm. Code de sortie non nul au moindre échec.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync } from 'node:fs'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { parseArgs } from 'node:util'
import { crc32, deflateSync, gunzipSync, inflateSync } from 'node:zlib'

const { values: args } = parseArgs({
  options: {
    image: { type: 'string' },
    cases: { type: 'string' },
    only: { type: 'string', multiple: true },
  },
})
if (args.image === undefined) {
  console.error('usage: container-compile-test.mjs --image <image> [--cases <dir>] [--only <case>]')
  process.exit(2)
}
const IMAGE = args.image

/** Constantes du protocole (copiées de @kaxolax/contracts et de l'agent, sans dépendance). */
const TOKEN_HEADER = 'x-internal-token'
const AGENT_PORT = 8080
const BUCKET = 'kaxolax-compile-outputs'
const COMPILES_DIR = '/srv/kaxolax/compiles'
const OUTPUTS_DIR = '/srv/kaxolax/outputs'
/** Sorties que le Worker relit (`OUTPUT_KEY` de container-server.ts, `CONTENT_TYPES` du runner). */
const SERVED_OUTPUTS = ['output.pdf', 'output.log', 'output.blg', 'output.synctex.gz']
const TEXT_EXTENSIONS = [
  '.tex',
  '.bib',
  '.cls',
  '.sty',
  '.bst',
  '.bbx',
  '.cbx',
  '.txt',
  '.md',
  '.csv',
]
const MAX_TEXT_BYTES = 2 * 1024 * 1024
// Délai maximal d'une conversion accepté par l'agent (MAX_CONVERT_TIMEOUT_MS de @kaxolax/contracts) :
// le `timeoutSeconds` d'un cas borne chaque étape (conversion, puis compilation du résultat).
const MAX_CONVERT_TIMEOUT_MS = 60_000
/** Cas exigés par la spécification (mêmes que malicious.test.ts). */
const REQUIRED_CASES = [
  'read-passwd-input',
  'write18',
  'openout-parent',
  'infinite-loop',
  'huge-pdf',
  'lua-network',
]

const suffix = randomBytes(4).toString('hex')
const token = randomBytes(32).toString('hex')
const names = {
  network: `kx-ctest-${suffix}-net`,
  agent: `kx-ctest-${suffix}`,
  relay: `kx-ctest-${suffix}-relay`,
}
let baseUrl = ''

// ---------------------------------------------------------------------------------------------
// Docker

/**
 * Lance `docker` et renvoie sa sortie standard ; une erreur si la commande échoue.
 * @param {string[]} argv
 * @param {{ env?: Record<string, string>, allowFailure?: boolean }} [options]
 */
function docker(argv, options = {}) {
  const result = spawnSync('docker', argv, {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, ...options.env },
  })
  if (result.status !== 0 && options.allowFailure !== true) {
    throw new Error(`docker ${argv.slice(0, 2).join(' ')} failed: ${result.stderr.trim()}`)
  }
  return result.stdout.trim()
}

/**
 * Commande dans le conteneur de l'agent, en root.
 * @param {string[]} argv
 */
function inAgent(argv) {
  return docker(['exec', '--user', '0', names.agent, ...argv])
}

/**
 * Entrées d'un dossier du conteneur, triées.
 * @param {string} path
 */
function listInAgent(path) {
  return inAgent(['ls', '-A', path]).split('\n').filter(Boolean).sort()
}

/** Relais TCP : le seul chemin de l'hôte vers l'agent (un réseau interne est fermé à l'hôte). */
const RELAY = `const net = require('node:net')
net.createServer((client) => {
  const agent = net.connect(${String(AGENT_PORT)}, 'compile')
  client.pipe(agent).pipe(client)
  client.on('error', () => agent.destroy())
  agent.on('error', () => client.destroy())
}).listen(${String(AGENT_PORT)})`

function startContainer() {
  docker(['network', 'create', '--internal', names.network])
  // Jeton et bucket : les `envVars` que le Durable Object passe au démarrage.
  docker(
    [
      'run',
      '--detach',
      '--name',
      names.agent,
      '--network',
      names.network,
      '--network-alias',
      'compile',
      '--env',
      'INTERNAL_TOKEN',
      '--env',
      `OUTPUT_BUCKET=${BUCKET}`,
      '--env',
      'AGENT_ID=ci-container-test',
      IMAGE,
    ],
    { env: { INTERNAL_TOKEN: token } },
  )
  docker([
    'run',
    '--detach',
    '--name',
    names.relay,
    '--publish',
    `127.0.0.1::${String(AGENT_PORT)}`,
    '--entrypoint',
    'node',
    IMAGE,
    '-e',
    RELAY,
  ])
  docker(['network', 'connect', names.network, names.relay])
  const address = docker(['port', names.relay, `${String(AGENT_PORT)}/tcp`]).split('\n')[0]
  baseUrl = `http://${address ?? ''}`
}

function stopContainer() {
  for (const name of [names.relay, names.agent]) {
    docker(['rm', '--force', '--volumes', name], { allowFailure: true })
  }
  docker(['network', 'rm', names.network], { allowFailure: true })
}

function agentLogs() {
  return docker(['logs', '--tail', '60', names.agent], { allowFailure: true })
}

// ---------------------------------------------------------------------------------------------
// HTTP (comme le port `ContainerPort` du Worker)

/**
 * @param {string} path
 * @param {RequestInit} [init]
 * @param {{ token?: string | null, timeoutMs?: number }} [options]
 */
function call(path, init = {}, options = {}) {
  const headers = new Headers(init.headers)
  const auth = options.token === undefined ? token : options.token
  if (auth !== null) headers.set(TOKEN_HEADER, auth)
  return fetch(`${baseUrl}${path}`, {
    ...init,
    headers,
    signal: AbortSignal.timeout(options.timeoutMs ?? 30_000),
  })
}

/**
 * POST JSON ; renvoie le statut et le corps lu en JSON.
 * @param {string} path
 * @param {unknown} body
 * @param {number} [timeoutMs]
 * @returns {Promise<{ status: number, body: any }>}
 */
async function postJson(path, body, timeoutMs) {
  const response = await call(
    path,
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) },
    { timeoutMs },
  )
  return { status: response.status, body: await response.json() }
}

/**
 * GET JSON (statut 200 exigé).
 * @param {string} path
 * @returns {Promise<any>}
 */
async function getJson(path) {
  const response = await call(path)
  assert.equal(response.status, 200, `GET ${path}`)
  return response.json()
}

async function waitForAgent() {
  const deadline = Date.now() + 120_000
  while (Date.now() < deadline) {
    if (docker(['inspect', '--format', '{{.State.Running}}', names.agent]) !== 'true') {
      throw new Error(`the compile container stopped:\n${agentLogs()}`)
    }
    try {
      const response = await call('/health', {}, { timeoutMs: 2_000 })
      if (response.status === 200) return
    } catch {
      // Agent pas encore à l'écoute.
    }
    await sleep(500)
  }
  throw new Error(`the compile container did not answer /health:\n${agentLogs()}`)
}

// ---------------------------------------------------------------------------------------------
// Projets, binaires et compilations

/** @param {Uint8Array | string} data */
function sha256(data) {
  return createHash('sha256').update(data).digest('hex')
}

/**
 * Même règle que `isTextDocument` de @kaxolax/contracts : extension texte, < 2 Mo, UTF-8 valide.
 * @param {string} path
 * @param {Buffer} bytes
 */
function textContent(path, bytes) {
  const lower = path.toLowerCase()
  if (!TEXT_EXTENSIONS.some((extension) => lower.endsWith(extension))) return null
  if (bytes.byteLength >= MAX_TEXT_BYTES) return null
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return null
  }
}

/**
 * @typedef {{ path: string, kind: 'text', content: string, sha256: string }
 *   | { path: string, kind: 'binary', s3Key: string, sha256: string }} Resource
 * @typedef {{ name: string, s3Key: string, sizeBytes: number }} OutputFile
 * @typedef {{ buildId: string, status: string, outputFiles: OutputFile[], entries: any[] }} CompileResponse
 */

/**
 * Ressources d'un projet (texte dans la demande, binaires à pousser dans le cache).
 * @param {string} projectId
 * @param {Record<string, Buffer | string>} files
 */
function projectResources(projectId, files) {
  /** @type {Resource[]} */
  const resources = []
  /** @type {Map<string, Buffer>} */
  const binaries = new Map()
  for (const [path, data] of Object.entries(files)) {
    const bytes = typeof data === 'string' ? Buffer.from(data) : data
    const content = textContent(path, bytes)
    if (content !== null) {
      resources.push({ path, kind: 'text', content, sha256: sha256(content) })
    } else {
      const hash = sha256(bytes)
      binaries.set(hash, bytes)
      resources.push({ path, kind: 'binary', s3Key: `projects/${projectId}/${path}`, sha256: hash })
    }
  }
  return { resources, binaries }
}

/**
 * Pousse les binaires absents du cache de l'agent (`pushBinaries` du runner) ; renvoie leurs hash.
 * @param {Map<string, Buffer>} binaries
 */
async function pushBinaries(binaries) {
  if (binaries.size === 0) return []
  const query = await postJson('/blobs/missing', { sha256: [...binaries.keys()] })
  assert.equal(query.status, 200, 'POST /blobs/missing')
  /** @type {string[]} */
  const missing = query.body.missing
  for (const hash of missing) {
    const bytes = binaries.get(hash)
    assert.ok(bytes !== undefined, `unknown blob ${hash} requested`)
    const response = await call(`/blobs/${hash}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/octet-stream' },
      body: new Uint8Array(bytes),
    })
    assert.equal(response.status, 204, `PUT /blobs/${hash}`)
  }
  return missing
}

/**
 * Compile un projet comme le Worker : binaires poussés, puis demande de compilation.
 * @param {string} projectId
 * @param {Record<string, Buffer | string>} files
 * @param {{ compiler?: string, timeoutMs?: number, root?: string }} [options]
 */
async function compile(projectId, files, options = {}) {
  const buildId = randomUUID()
  const { resources, binaries } = projectResources(projectId, files)
  const pushed = await pushBinaries(binaries)
  const timeoutMs = options.timeoutMs ?? 60_000
  const request = {
    projectId,
    buildId,
    compiler: options.compiler ?? 'pdflatex',
    rootResourcePath: options.root ?? 'main.tex',
    timeoutMs,
    resources,
    output: { bucket: BUCKET, prefix: `outputs/${projectId}/${buildId}/` },
  }
  const response = await postJson(`/projects/${projectId}/compile`, request, timeoutMs + 120_000)
  assert.equal(response.status, 200, `compile answered ${JSON.stringify(response.body)}`)
  /** @type {CompileResponse} */
  const result = response.body
  assert.equal(result.buildId, buildId)
  for (const file of result.outputFiles) {
    assert.equal(file.s3Key, `outputs/${projectId}/${buildId}/${file.name}`, 'output key')
  }
  return { buildId, result, pushed, resources }
}

/**
 * Relit les sorties comme `copyOutputs` du runner (taille annoncée vérifiée).
 * @param {CompileResponse} result
 */
async function readOutputs(result) {
  /** @type {Map<string, Buffer>} */
  const outputs = new Map()
  for (const file of result.outputFiles) {
    if (!SERVED_OUTPUTS.includes(file.name)) continue
    const response = await call(`/outputs/${file.s3Key}`)
    assert.equal(response.status, 200, `GET /outputs/${file.s3Key}`)
    const bytes = Buffer.from(await response.arrayBuffer())
    assert.equal(bytes.byteLength, file.sizeBytes, `size of ${file.name}`)
    outputs.set(file.name, bytes)
  }
  return outputs
}

/**
 * Supprime les sorties du build (le Worker le fait après leur copie dans R2), puis le projet.
 * @param {string} projectId
 * @param {string | null} buildId
 */
async function cleanupProject(projectId, buildId) {
  if (buildId !== null) {
    const deleted = await call(`/outputs/${projectId}/${buildId}`, { method: 'DELETE' })
    assert.equal(deleted.status, 204, 'DELETE outputs')
  }
  const cleared = await postJson(`/projects/${projectId}/clear-cache`, {})
  assert.equal(cleared.status, 200, 'clear-cache')
}

/**
 * Nettoyage en fin de vérification : un échec est affiché sans masquer l'erreur de la
 * vérification (un projet resté en place fait échouer la vérification finale).
 * @param {string} projectId
 * @param {string | null} buildId
 */
async function cleanupAfter(projectId, buildId) {
  try {
    await cleanupProject(projectId, buildId)
  } catch (error) {
    console.log(`  # cleanup of ${projectId} failed: ${String(error)}`)
  }
}

/**
 * Copie hors du conteneur un dossier (répertoire de travail, sorties) pour l'inspecter.
 * @param {string} path
 * @param {string} target
 */
function copyFromAgent(path, target) {
  docker(['cp', `${names.agent}:${path}`, target])
  return target
}

/** @param {string} directory @returns {Promise<string[]>} */
async function allFiles(directory) {
  /** @type {string[]} */
  const result = []
  for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) result.push(...(await allFiles(path)))
    else if (entry.isFile()) result.push(path)
  }
  return result.sort()
}

/**
 * Texte lisible d'un fichier (flux PDF décompressés), comme malicious.test.ts.
 * @param {Buffer} bytes
 * @param {string} name
 */
function readable(bytes, name) {
  if (name.endsWith('.gz')) return gunzipSync(bytes).toString('latin1')
  if (!name.endsWith('.pdf')) return bytes.toString('latin1')
  const parts = [bytes.toString('latin1')]
  for (const match of bytes.toString('latin1').matchAll(/stream\r?\n([\s\S]*?)\r?\nendstream/g)) {
    try {
      parts.push(inflateSync(Buffer.from(match[1] ?? '', 'latin1')).toString('latin1'))
    } catch {
      // Flux non compressé ou autre filtre.
    }
  }
  return parts.join('\n')
}

/**
 * Tout ce qu'une compilation laisse lisible : réponse de l'agent, sorties relues par HTTP,
 * répertoire de travail et sorties gardées par l'agent. Seules les ressources envoyées, restées
 * intactes, sont exclues (elles contiennent les chemins demandés) : un fichier écrit par la
 * compilation (\openout d'un `leak.tex`, par exemple) est inspecté, quelle que soit son extension.
 * malicious.test.ts de l'agent exclut encore tous les `.tex` : ce script est plus strict.
 * @param {string} projectId
 * @param {string} buildId
 * @param {CompileResponse} result
 * @param {Map<string, Buffer>} outputs
 * @param {Resource[]} resources
 * @param {string} scratch
 */
async function everythingReadable(projectId, buildId, result, outputs, resources, scratch) {
  const texts = [JSON.stringify(result)]
  for (const [name, bytes] of outputs) texts.push(readable(bytes, name))
  const workdir = copyFromAgent(`${COMPILES_DIR}/${projectId}/files`, join(scratch, 'files'))
  const kept = join(scratch, 'outputs')
  if (result.outputFiles.length > 0) {
    copyFromAgent(`${OUTPUTS_DIR}/${BUCKET}/outputs/${projectId}/${buildId}`, kept)
  }
  const sent = new Map(resources.map((resource) => [resource.path, resource.sha256]))
  for (const path of await allFiles(workdir)) {
    const bytes = await readFile(path)
    if (sent.get(relative(workdir, path)) === sha256(bytes)) continue
    texts.push(readable(bytes, path))
  }
  for (const path of await allFiles(kept)) texts.push(readable(await readFile(path), path))
  return { texts, workdir }
}

/**
 * Fichier témoin réservé à root, hors du dossier des compilations (l'équivalent de l'hôte).
 * @param {string} fileName
 */
function createCanary(fileName) {
  const directory = `/srv/kaxolax/kx-canary-${randomBytes(6).toString('hex')}`
  const content = `KX-HOST-CANARY-${randomUUID()}`
  inAgent([
    'sh',
    '-c',
    'umask 077 && mkdir "$1" && printf "%s" "$2" > "$1/$3"',
    'sh',
    directory,
    content,
    fileName,
  ])
  return { directory, path: `${directory}/${fileName}`, content }
}

/**
 * Le projet ne laisse rien hors de son répertoire de travail, et le témoin est intact.
 * @param {string} projectId
 * @param {{ directory: string, path: string }} canary
 */
function assertConfined(projectId, canary) {
  assert.deepEqual(listInAgent(`${COMPILES_DIR}/${projectId}`), ['files', 'state.json'])
  assert.deepEqual(listInAgent(canary.directory), [canary.path.slice(canary.directory.length + 1)])
}

/**
 * Aucun marqueur dans ce qu'une compilation laisse lisible.
 * @param {string[]} texts
 * @param {string[]} markers
 */
function assertNoLeak(texts, markers) {
  for (const marker of markers) {
    assert.ok(!texts.some((text) => text.includes(marker)), `leak of ${marker}`)
  }
}

// ---------------------------------------------------------------------------------------------
// Document de test

/**
 * PNG RVB minimal (carré uni) : la figure binaire du document de test.
 * @param {number} size
 */
function png(size) {
  /** @param {string} type @param {Buffer} data */
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data])
    const out = Buffer.alloc(8 + data.length + 4)
    out.writeUInt32BE(data.length, 0)
    body.copy(out, 4)
    out.writeUInt32BE(crc32(body), 8 + data.length)
    return out
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(size, 0)
  header.writeUInt32BE(size, 4)
  header[8] = 8
  header[9] = 2
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(size * 3, 0x3c)])
  const pixels = Buffer.concat(Array.from({ length: size }, () => row))
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(pixels)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

const MAIN_TEX = String.raw`\documentclass{article}
\usepackage{graphicx}
\begin{document}
\section{Kaxolax}
The compile container builds this document~\cite{knuth1984}.

\input{chapters/intro}

\includegraphics[width=2cm]{figures/square.png}

\bibliographystyle{plain}
\bibliography{refs}
\end{document}
`
const DOCUMENT = {
  'main.tex': MAIN_TEX,
  'chapters/intro.tex': 'Text from an included chapter, with a few words to count.\n',
  'refs.bib':
    '@book{knuth1984,\n  author = {Donald E. Knuth},\n  title = {The {\\TeX}book},\n' +
    '  publisher = {Addison-Wesley},\n  year = {1984}\n}\n',
  'figures/square.png': png(16),
}
/** Ligne du texte principal (SyncTeX). */
const TEXT_LINE = MAIN_TEX.split('\n').findIndex((line) => line.startsWith('The compile')) + 1

// ---------------------------------------------------------------------------------------------
// Vérifications

/** @type {Array<{ name: string, error?: unknown, skip?: string, ms: number }>} */
const results = []

/**
 * Une vérification au format TAP ; `run` peut renvoyer `{ skip }` : vérification non exécutée,
 * signalée `# SKIP` (jamais comptée comme réussie).
 * @param {string} name
 * @param {() => Promise<void | { skip: string }>} run
 */
async function check(name, run) {
  const started = performance.now()
  try {
    const outcome = await run()
    const ms = Math.round(performance.now() - started)
    if (outcome) {
      results.push({ name, skip: outcome.skip, ms })
      console.log(`ok ${String(results.length)} - ${name} # SKIP ${outcome.skip}`)
      return
    }
    results.push({ name, ms })
    console.log(`ok ${String(results.length)} - ${name} (${(ms / 1000).toFixed(1)} s)`)
  } catch (error) {
    const ms = Math.round(performance.now() - started)
    results.push({ name, error, ms })
    console.log(`not ok ${String(results.length)} - ${name}`)
    console.log(`  ${String(error instanceof Error ? (error.stack ?? error.message) : error)}`)
  }
}

/**
 * PID de l'agent (node dist/container-main.js) dans le conteneur : commande qui commence par node
 * (un init comme `tini -- node …` porte aussi le chemin), et le motif `[.]` évite que le shell de
 * la recherche se trouve lui-même.
 */
function findAgentPid() {
  const pids = inAgent([
    'sh',
    '-c',
    `for dir in /proc/[0-9]*; do
      tr '\\0' ' ' < "$dir/cmdline" 2>/dev/null | grep -q '^[^ ]*node [^ ]*container-main[.]js' && echo "\${dir#/proc/}"
    done
    true`,
  ])
    .split('\n')
    .filter(Boolean)
  assert.equal(pids.length, 1, `one agent process expected, found ${JSON.stringify(pids)}`)
  return Number(pids[0])
}

/** Inits qui réclament les orphelins en PID 1. */
const INIT_COMMAND = /^(\/\S*\/)?(tini|docker-init|dumb-init|catatonit)\b/

/** PID de l'agent, connu après `checkAuthentication` (sa cible `/proc/<pid>/environ`). */
let agentPid = 0

async function checkAuthentication() {
  assert.equal((await call('/health', {}, { token: null })).status, 401, 'without token')
  const wrong = randomBytes(32).toString('hex')
  assert.equal((await call('/health', {}, { token: wrong })).status, 401, 'wrong token')
  const health = await getJson('/health')
  assert.equal(health.agentId, 'ci-container-test')
  assert.equal(health.capacity, 1)
  // L'agent, fils direct d'un init : son /proc/<pid>/environ, qui contient le jeton interne, sert
  // de cible plus loin. Node en PID 1 ne réclame pas les orphelins d'une compilation tuée (ils
  // restent zombies et comptent dans RLIMIT_NPROC) : un init qui les réclame est exigé en PID 1.
  agentPid = findAgentPid()
  assert.notEqual(
    agentPid,
    1,
    'the agent is PID 1 and Node does not reap orphans: run it under an init ' +
      '(ENTRYPOINT ["tini", "--"] in apps/compile-worker/container/Dockerfile)',
  )
  const init = inAgent(['sh', '-c', `tr '\\0' ' ' < /proc/1/cmdline`])
  assert.match(init, INIT_COMMAND, `PID 1 is not a reaping init: ${init}`)
  const status = inAgent(['cat', `/proc/${String(agentPid)}/status`])
  assert.match(status, /^PPid:\s+1$/m, 'the agent is a direct child of the init')
}

async function checkRealCompile() {
  const projectId = randomUUID()
  try {
    await realCompile(projectId)
  } finally {
    await cleanupAfter(projectId, null)
  }
}

/** @param {string} projectId */
async function realCompile(projectId) {
  const figure = /** @type {Buffer} */ (DOCUMENT['figures/square.png'])

  // Un binaire corrompu est refusé (le Worker en fait « Project file is corrupted »).
  const forged = await call(`/blobs/${sha256(figure)}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/octet-stream' },
    body: Buffer.from('not the announced content'),
  })
  assert.equal(forged.status, 400, 'corrupted blob')

  const first = await compile(projectId, DOCUMENT)
  assert.deepEqual(first.pushed, [sha256(figure)], 'the figure is pushed once')
  assert.equal(first.result.status, 'success', JSON.stringify(first.result.entries))
  assert.ok(!first.result.entries.some((entry) => entry.level === 'error'), 'no error entry')
  const produced = first.result.outputFiles.map((file) => file.name)
  for (const name of SERVED_OUTPUTS) assert.ok(produced.includes(name), `${name} produced`)

  const outputs = await readOutputs(first.result)
  const pdf = outputs.get('output.pdf') ?? Buffer.alloc(0)
  assert.equal(pdf.subarray(0, 5).toString('latin1'), '%PDF-')
  assert.match(pdf.subarray(-32).toString('latin1'), /%%EOF\s*$/)
  assert.match(
    (outputs.get('output.log') ?? '').toString('latin1'),
    /Output written on output\.pdf/,
  )
  assert.match((outputs.get('output.blg') ?? '').toString('latin1'), /database file #1: refs\.bib/i)
  const synctex = gunzipSync(outputs.get('output.synctex.gz') ?? Buffer.alloc(0)).toString('utf8')
  assert.match(synctex, /^SyncTeX Version:/)
  assert.match(synctex, /^Input:\d+:.*\/main\.tex$/m)
  assert.match(synctex, /^Input:\d+:.*\/chapters\/intro\.tex$/m)

  // SyncTeX du code vers le PDF, puis du PDF vers le code.
  assert.deepEqual(await getJson(`/projects/${projectId}/synctex/available`), { available: true })
  /** @type {{ pdf: Array<{ page: number, h: number, v: number }> }} */
  const view = await getJson(
    `/projects/${projectId}/synctex/code?file=main.tex&line=${String(TEXT_LINE)}&column=0`,
  )
  const position = view.pdf[0]
  assert.ok(position !== undefined && position.page === 1, 'position in the PDF')
  /** @type {{ code: Array<{ file: string, line: number }> }} */
  const edit = await getJson(
    `/projects/${projectId}/synctex/pdf?page=1&h=${String(position.h)}&v=${String(position.v)}`,
  )
  assert.ok(
    edit.code.some((code) => code.file === 'main.tex' && code.line === TEXT_LINE),
    `back to main.tex:${String(TEXT_LINE)}: ${JSON.stringify(edit.code)}`,
  )

  // Seules les sorties du build sont lisibles.
  for (const path of [
    `/outputs/outputs/${projectId}/${first.buildId}/main.tex`,
    `/outputs/outputs/${projectId}/${first.buildId}/..%2f..%2f..%2fstate.json`,
    '/outputs/..%2f..%2fetc%2fpasswd',
  ]) {
    assert.equal((await call(path)).status, 404, `GET ${path}`)
  }

  // Comptage de mots (texcount dans le même sandbox).
  const count = await postJson(`/projects/${projectId}/word-count`, {
    projectId,
    rootResourcePath: 'main.tex',
    resources: first.resources.filter((resource) => resource.kind === 'text'),
  })
  assert.equal(count.status, 200, JSON.stringify(count.body))
  assert.ok(count.body.total.words >= 15, `word count: ${JSON.stringify(count.body.total)}`)

  // Deuxième compilation (incrémentale) : le binaire est déjà dans le cache, rien n'est repoussé.
  assert.equal(
    (await call(`/outputs/${projectId}/${first.buildId}`, { method: 'DELETE' })).status,
    204,
  )
  const second = await compile(projectId, {
    ...DOCUMENT,
    'main.tex': MAIN_TEX.replace('builds this', 'builds again this'),
  })
  assert.deepEqual(second.pushed, [], 'binary served from the cache')
  assert.equal(second.result.status, 'success')
  const synctexAgain = (await readOutputs(second.result)).get('output.synctex.gz')
  assert.ok(synctexAgain !== undefined)
  assert.equal(
    (await call(`/outputs/${projectId}/${second.buildId}`, { method: 'DELETE' })).status,
    204,
  )
  assert.equal(
    (await call(`/outputs/outputs/${projectId}/${second.buildId}/output.pdf`)).status,
    404,
    'outputs deleted',
  )

  // VM recyclée : le Worker restaure le SyncTeX depuis R2 avant une requête.
  assert.equal((await postJson(`/projects/${projectId}/clear-cache`, {})).status, 200)
  assert.deepEqual(await getJson(`/projects/${projectId}/synctex/available`), { available: false })
  const restored = await call(`/projects/${projectId}/synctex?root=main.tex`, {
    method: 'PUT',
    headers: { 'content-type': 'application/gzip' },
    body: new Uint8Array(synctexAgain),
  })
  assert.equal(restored.status, 204, 'SyncTeX restored')
  /** @type {{ pdf: unknown[] }} */
  const restoredView = await getJson(
    `/projects/${projectId}/synctex/code?file=main.tex&line=${String(TEXT_LINE)}&column=0`,
  )
  assert.ok(restoredView.pdf.length > 0, 'SyncTeX answers after the restore')
}

/**
 * \input d'un fichier hors du dossier du projet : refusé, rien ne fuit.
 * @param {string} scratch
 * @param {'absolute' | 'relative' | 'agent-environment'} target
 */
async function checkInputOutside(scratch, target) {
  const canary = createCanary('canary.tex')
  const projectId = randomUUID()
  const workdirDepth = `${COMPILES_DIR}/${projectId}/files`.split('/').length - 1
  const requested =
    target === 'absolute'
      ? canary.path
      : target === 'relative'
        ? `${'../'.repeat(workdirDepth)}${canary.path.slice(1)}`
        : `/proc/${String(agentPid || findAgentPid())}/environ`
  /** @type {string | null} */
  let buildId = null
  try {
    const {
      buildId: id,
      result,
      resources,
    } = await compile(projectId, {
      'main.tex': `\\documentclass{article}\n\\begin{document}\nBefore.\n\\input{${requested}}\n\\end{document}\n`,
    })
    buildId = id
    assert.equal(result.status, 'failure', `status ${result.status}`)
    const outputs = await readOutputs(result)
    const log = (outputs.get('output.log') ?? Buffer.alloc(0)).toString('utf8')
    assert.ok(log.includes(requested.split('/').pop() ?? requested), 'the log names the file')
    assert.ok(!outputs.has('output.pdf'), 'no PDF')
    const { texts } = await everythingReadable(
      projectId,
      buildId,
      result,
      outputs,
      resources,
      scratch,
    )
    assertNoLeak(texts, [canary.content, token])
    assertConfined(projectId, canary)
  } finally {
    inAgent(['rm', '-rf', canary.directory])
    await cleanupAfter(projectId, buildId)
  }
}

/**
 * Cas des fichiers d'un dossier (case.json exclu), dotfiles compris.
 * @param {string} directory
 * @param {string} [base]
 * @returns {Promise<string[]>}
 */
async function caseFiles(directory, base = directory) {
  /** @type {string[]} */
  const result = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) result.push(...(await caseFiles(path, base)))
    else if (entry.isFile() && relative(base, path) !== 'case.json')
      result.push(relative(base, path))
  }
  return result.sort()
}

/**
 * @typedef {{ mode?: string, documentClass?: string, rawLatex?: boolean, citations?: string,
 *   sourceDir?: string, graphicsDir?: string, mediaDir?: string, compile?: string }} ConvertSpec
 * @typedef {{ compiler?: string, command?: string[], convert?: ConvertSpec, timeoutSeconds?: number,
 *   expect: { status?: string[], logContains?: string[], logLacks?: string[], noLeak?: string[],
 *   absentFiles?: string[], texContains?: string[], texLacks?: string[],
 *   reportContains?: string[] } }} MaliciousCase
 */

/**
 * case.json d'un cas de la suite malveillante.
 * @param {string} directory
 * @returns {Promise<MaliciousCase>}
 */
async function readCase(directory) {
  return /** @type {MaliciousCase} */ (
    JSON.parse(await readFile(join(directory, 'case.json'), 'utf8'))
  )
}

/**
 * Un cas de la suite malveillante (format case.json de kaxolax-texlive-images). `outputContains`
 * (sortie standard de latexmk) n'est pas vérifiable par l'API : ignoré, comme dans l'agent. Un cas
 * `command` (commande arbitraire, hors API de compilation) n'est pas exécuté : signalé `# SKIP`.
 * @param {string} directory
 * @param {string} scratch
 * @returns {Promise<void | { skip: string }>}
 */
async function checkMaliciousCase(directory, scratch) {
  const spec = await readCase(directory)
  if (spec.command) return { skip: 'command case, not reachable through the compile API' }
  if (spec.convert) return checkConvertCase(directory, spec, scratch)
  const canary = createCanary('host-canary.txt')
  const projectId = randomUUID()
  /** @type {string | null} */
  let buildId = null
  try {
    /** @type {Record<string, Buffer>} */
    const files = {}
    for (const path of await caseFiles(directory)) {
      const bytes = await readFile(join(directory, path))
      const content = textContent(path, bytes)
      files[path] =
        content === null ? bytes : Buffer.from(content.replaceAll('@@HOST_CANARY@@', canary.path))
    }
    const {
      buildId: id,
      result,
      resources,
    } = await compile(projectId, files, {
      compiler: spec.compiler ?? 'pdflatex',
      timeoutMs: (spec.timeoutSeconds ?? 60) * 1000,
    })
    buildId = id
    const expected = spec.expect
    assert.ok((expected.status ?? ['success']).includes(result.status), `status ${result.status}`)

    const outputs = await readOutputs(result)
    const { texts, workdir } = await everythingReadable(
      projectId,
      buildId,
      result,
      outputs,
      resources,
      scratch,
    )
    const log = await readFile(join(workdir, 'output.log'), 'utf8').catch(() => '')
    for (const text of expected.logContains ?? []) assert.ok(log.includes(text), `log has ${text}`)
    for (const text of expected.logLacks ?? []) assert.ok(!log.includes(text), `log lacks ${text}`)
    for (const path of expected.absentFiles ?? []) {
      assert.ok(!existsSync(join(workdir, path)), `${path} must not exist`)
    }
    assertConfined(projectId, canary)
    const markers = (expected.noLeak ?? []).map((marker) =>
      marker.replace('@@HOST_CANARY_CONTENT@@', canary.content),
    )
    assertNoLeak(texts, [...markers, token])
  } finally {
    inAgent(['rm', '-rf', canary.directory])
    await cleanupAfter(projectId, buildId)
  }
}

// ---------------------------------------------------------------------------------------------
// Conversion Markdown → LaTeX (pandoc dans le sandbox du conteneur)

/** Répertoire des conversions de l'agent (`CONVERT_DIR`), vidé après chacune. */
const CONVERT_DIR = `${COMPILES_DIR}/.convert`

/** L'image TeX Live a-t-elle pandoc ? (images publiées avant son ajout : non) */
function hasPandoc() {
  const result = spawnSync('docker', ['exec', names.agent, 'pandoc', '--version'], {
    encoding: 'utf8',
  })
  return result.status === 0
}

/**
 * Demande de conversion comme l'API l'envoie (`ConvertRequest`) ; statut `success`, `failure` ou
 * `timeout` (échecs 422 de l'agent).
 * @param {Record<string, unknown>} request
 * @param {number} timeoutMs
 * @returns {Promise<{ status: string, body: any }>}
 */
async function convert(request, timeoutMs) {
  const response = await postJson(
    `/projects/${String(request.projectId)}/convert`,
    { ...request, timeoutMs },
    timeoutMs + 60_000,
  )
  if (response.status === 200) return { status: 'success', body: response.body }
  assert.equal(response.status, 422, `convert answered ${JSON.stringify(response.body)}`)
  assert.equal(response.body.error, 'convert_failed')
  return { status: response.body.reason === 'timeout' ? 'timeout' : 'failure', body: response.body }
}

/**
 * Fichiers d'une compilation du LaTeX converti : le `.tex`, les images extraites et des fichiers
 * du projet.
 * @param {string} texPath
 * @param {any} result
 * @param {Record<string, Buffer | string>} [extra]
 */
function convertedProject(texPath, result, extra = {}) {
  /** @type {Record<string, Buffer | string>} */
  const files = { ...extra, [texPath]: result.latex }
  for (const media of result.media) files[media.path] = Buffer.from(media.contentBase64, 'base64')
  return files
}

const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAIAAAAmkwkpAAAAEElEQVR4nGM4IScHRwzEcQCxYxBBO0tjggAAAABJRU5ErkJggg=='
const RICH_MARKDOWN = `---
title: Conversion
---

# Introduction

Du *Markdown* avec une note[^1], une formule $e^{i\\pi} + 1 = 0$ et des accents : élève.

[^1]: La note.

| Moteur | Unicode |
|--------|---------|
| pdfLaTeX | non |

\`\`\`python
print("Bonjour")
\`\`\`

![Figure](figures/square.png)

![Intégrée](data:image/png;base64,${PNG_BASE64})
`

async function checkConvert() {
  if (!hasPandoc()) return { skip: 'the TeX Live image has no pandoc' }
  const projectId = randomUUID()
  /** @type {string | null} */
  let buildId = null
  try {
    const converted = await convert(
      {
        projectId,
        sourcePath: 'notes.md',
        targetPath: 'notes.tex',
        markdown: RICH_MARKDOWN,
        media: ['figures/square.png'],
      },
      30_000,
    )
    assert.equal(converted.status, 'success', JSON.stringify(converted.body))
    const result = converted.body
    assert.equal(result.title, 'Conversion')
    assert.match(result.latex, /\\section\{Introduction\}/)
    assert.match(result.latex, /\{figures\/square\.png\}/)
    assert.equal(result.media.length, 1, 'one embedded image extracted')
    assert.match(result.media[0].path, /^media\/[0-9a-f]{40}\.png$/)
    assert.deepEqual(
      result.images.map((/** @type {any} */ image) => [image.kind, image.found]),
      [
        ['project', true],
        ['embedded', null],
      ],
    )
    assert.deepEqual(listInAgent(CONVERT_DIR), [], 'conversion directory removed')
    const compiled = await compile(
      projectId,
      convertedProject('notes.tex', result, { 'figures/square.png': png(16) }),
      { root: 'notes.tex' },
    )
    buildId = compiled.buildId
    assert.equal(compiled.result.status, 'success', JSON.stringify(compiled.result.entries))
  } finally {
    await cleanupAfter(projectId, buildId)
  }
}

/**
 * Cas `convert` de la suite malveillante : conversion par l'API du conteneur, compilation
 * éventuelle du résultat, puis attentes du cas (texte du LaTeX, rapport, fuites, confinement).
 * @param {string} directory
 * @param {MaliciousCase} spec
 * @param {string} scratch
 * @returns {Promise<void | { skip: string }>}
 */
async function checkConvertCase(directory, spec, scratch) {
  if (!hasPandoc()) return { skip: 'the TeX Live image has no pandoc' }
  const options = spec.convert ?? {}
  const canary = createCanary('host-canary.txt')
  const projectId = randomUUID()
  /** @type {string | null} */
  let buildId = null
  try {
    const markdown = (await readFile(join(directory, 'input.md'), 'utf8')).replaceAll(
      '@@HOST_CANARY@@',
      canary.path,
    )
    const sourceDir = options.sourceDir ?? ''
    const converted = await convert(
      {
        projectId,
        sourcePath: sourceDir === '' ? 'input.md' : `${sourceDir}/input.md`,
        targetPath: 'output.tex',
        graphicsDir: options.graphicsDir ?? '',
        mediaDir: options.mediaDir ?? 'media',
        markdown,
        options: {
          mode: options.mode,
          documentClass: options.documentClass,
          citations: options.citations,
          rawLatex: options.rawLatex,
        },
      },
      Math.min((spec.timeoutSeconds ?? 30) * 1000, MAX_CONVERT_TIMEOUT_MS),
    )
    let status = converted.status
    const texts = [JSON.stringify(converted.body)]
    assert.deepEqual(listInAgent(CONVERT_DIR), [], 'conversion directory removed')
    if (status === 'success' && options.compile !== undefined) {
      const compiled = await compile(projectId, convertedProject('output.tex', converted.body), {
        compiler: options.compile,
        root: 'output.tex',
        timeoutMs: (spec.timeoutSeconds ?? 60) * 1000,
      })
      buildId = compiled.buildId
      status = compiled.result.status
      const outputs = await readOutputs(compiled.result)
      const readableNow = await everythingReadable(
        projectId,
        buildId,
        compiled.result,
        outputs,
        compiled.resources,
        scratch,
      )
      texts.push(...readableNow.texts)
      for (const path of spec.expect.absentFiles ?? []) {
        assert.ok(!existsSync(join(readableNow.workdir, path)), `${path} must not exist`)
      }
      assertConfined(projectId, canary)
    } else {
      assert.deepEqual(listInAgent(canary.directory), ['host-canary.txt'])
    }
    const expected = spec.expect
    assert.ok((expected.status ?? ['success']).includes(status), `status ${status}`)
    const latex = converted.status === 'success' ? String(converted.body.latex) : ''
    for (const text of expected.texContains ?? [])
      assert.ok(latex.includes(text), `LaTeX has ${text}`)
    for (const text of expected.texLacks ?? [])
      assert.ok(!latex.includes(text), `LaTeX lacks ${text}`)
    // Rapport du filtre tel que l'agent le restitue : images, clés citées, clés refusées.
    const report = JSON.stringify({
      images: converted.body.images ?? [],
      citations: converted.body.citations ?? [],
      warnings: converted.body.warnings ?? [],
    })
    for (const text of expected.reportContains ?? [])
      assert.ok(report.includes(text), `report has ${text}`)
    const markers = (expected.noLeak ?? []).map((marker) =>
      marker.replace('@@HOST_CANARY_CONTENT@@', canary.content),
    )
    assertNoLeak(texts, [...markers, token])
  } finally {
    inAgent(['rm', '-rf', canary.directory])
    await cleanupAfter(projectId, buildId)
  }
}

/** @param {string} scratch */
function maliciousCasesDirectory(scratch) {
  if (args.cases !== undefined) return args.cases
  const id = docker(['create', IMAGE])
  try {
    docker(['cp', `${id}:/usr/share/kaxolax/malicious`, join(scratch, 'malicious')])
  } catch (error) {
    throw new Error(
      `${IMAGE} has no /usr/share/kaxolax/malicious (TeX Live image of kaxolax-texlive-images ` +
        `expected); pass --cases <kaxolax-texlive-images/tests/malicious>`,
      { cause: error },
    )
  } finally {
    docker(['rm', id], { allowFailure: true })
  }
  return join(scratch, 'malicious')
}

/** Processus de l'UID du sandbox dans le conteneur : « pid état commande ». */
const SANDBOX_PROCESSES = `for dir in /proc/[0-9]*; do
  grep -qE "^Uid:[[:space:]]+1000[[:space:]]" "$dir/status" 2>/dev/null || continue
  state=$(sed -n 's/^State:[[:space:]]*\\([A-Z]\\).*/\\1/p' "$dir/status")
  echo "\${dir#/proc/} $state $(tr '\\0' ' ' < "$dir/cmdline")"
done`

/**
 * Après la suite : agent vivant, aucun processus de l'UID du sandbox, zombies compris (orphelins
 * d'une compilation tuée que PID 1 doit réclamer : sinon ils comptent dans RLIMIT_NPROC tant que
 * la VM vit), aucun projet restant.
 */
async function checkAfterSuite() {
  assert.equal((await call('/health')).status, 200)
  const processes = inAgent(['sh', '-c', SANDBOX_PROCESSES]).split('\n').filter(Boolean)
  const zombies = processes.filter((line) => line.split(' ')[1] === 'Z')
  const alive = processes.filter((line) => line.split(' ')[1] !== 'Z')
  assert.deepEqual(alive, [], 'no live process of the sandbox UID remains')
  assert.deepEqual(
    zombies,
    [],
    'no zombie of the sandbox UID remains: PID 1 must reap the orphans of killed compiles',
  )
  assert.deepEqual(
    listInAgent(COMPILES_DIR).filter((name) => !name.startsWith('.')),
    [],
    'every project was cleared',
  )
}

// ---------------------------------------------------------------------------------------------

const scratchRoot = await mkdtemp(join(tmpdir(), 'kx-container-test-'))
/** Dossier de travail propre à une vérification. */
let scratchIndex = 0
const scratch = () => {
  const directory = join(scratchRoot, String(++scratchIndex))
  mkdirSync(directory)
  return directory
}
let exitCode = 0
try {
  console.log(`# compile container ${IMAGE}`)
  startContainer()
  await waitForAgent()
  const casesDir = maliciousCasesDirectory(scratchRoot)
  const cases = (await readdir(casesDir))
    .filter((name) => existsSync(join(casesDir, name, 'case.json')))
    .sort()

  await check('internal token required, agent under a reaping PID 1', checkAuthentication)
  await check('real pdfLaTeX compile: PDF, log, BibTeX, SyncTeX, word count, cache', () =>
    checkRealCompile(),
  )
  await check('Markdown converted by pandoc in the sandbox, then compiled', checkConvert)
  for (const target of /** @type {const} */ (['absolute', 'relative', 'agent-environment'])) {
    await check(`\\input outside the project (${target}) is refused`, () =>
      checkInputOutside(scratch(), target),
    )
  }
  // Un cas exigé doit passer par l'API de compilation : un cas `command` ne serait pas exécuté.
  await check('malicious suite ships the required cases, all run through the API', async () => {
    for (const name of REQUIRED_CASES) {
      assert.ok(cases.includes(name), `case ${name}`)
      const spec = await readCase(join(casesDir, name))
      assert.equal(spec.command, undefined, `case ${name} is a command case`)
    }
  })
  for (const name of cases) {
    if (args.only !== undefined && !args.only.includes(name)) continue
    await check(`malicious: ${name}`, () => checkMaliciousCase(join(casesDir, name), scratch()))
  }
  await check('agent healthy and sandbox empty after the suite', checkAfterSuite)
} catch (error) {
  console.log(
    `Bail out! ${String(error instanceof Error ? (error.stack ?? error.message) : error)}`,
  )
  exitCode = 1
} finally {
  const failed = results.filter((result) => result.error !== undefined)
  const skipped = results.filter((result) => result.skip !== undefined)
  if (failed.length > 0 || exitCode !== 0) console.log(`# agent logs\n${agentLogs()}`)
  stopContainer()
  await rm(scratchRoot, { recursive: true, force: true })
  const passed = results.length - failed.length - skipped.length
  console.log(
    `# ${String(passed)}/${String(results.length)} passed, ${String(skipped.length)} skipped`,
  )
  if (failed.length > 0) exitCode = 1
}
process.exit(exitCode)
