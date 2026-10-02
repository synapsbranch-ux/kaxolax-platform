import { DEFAULT_COMPILE_TIMEOUT_MS, WORD_COUNT_TIMEOUT_MS } from '@kaxolax/contracts'
import env from '#start/env'

const backend = env.get('COMPILE_BACKEND') ?? 'gateway'
const gatewayUrl = env.get('COMPILE_GATEWAY_URL')
const workerUrl = env.get('COMPILE_WORKER_URL')
const workerSecret = env.get('COMPILE_WORKER_SECRET')
if (backend === 'gateway' && gatewayUrl === undefined) {
  throw new Error('COMPILE_GATEWAY_URL is required when COMPILE_BACKEND=gateway')
}
if (backend === 'cloudflare' && (workerUrl === undefined || workerSecret === undefined)) {
  throw new Error(
    'COMPILE_WORKER_URL and COMPILE_WORKER_SECRET are required when COMPILE_BACKEND=cloudflare',
  )
}

/**
 * Compilation : synchrone par le compile-gateway (`gateway`, défaut en local et en CI), ou
 * asynchrone par le Worker Cloudflare (`cloudflare`, production). Délais et durée de validité des
 * URL de sortie.
 */
const compileConfig = {
  backend,
  gatewayUrl: gatewayUrl ?? '',
  internalToken: env.get('INTERNAL_TOKEN'),
  workerUrl: workerUrl ?? '',
  workerSecret,
  /** Appels au Worker (mise en file, annulation, réveil, SyncTeX) : jamais une compilation. */
  workerCallTimeoutMs: 15_000,
  /**
   * Au-delà de son timeout plus cette marge (réveil du conteneur, transferts), une compilation
   * toujours active sans nouvelles du Worker est close en erreur : le verrou du projet est libéré.
   */
  staleBuildMarginMs: 5 * 60_000,
  /**
   * Plafond par utilisateur : projets distincts dont il a réveillé le compilateur Cloudflare sur
   * la fenêtre (durée de mise en sommeil du conteneur, `sleepAfter`). Au-delà : 429.
   */
  maxCompilersPerUser: 5,
  compilerWindowMs: 15 * 60_000,
  /**
   * Repli pour les compilations enregistrées sans durée maximale (anciennes lignes) ; chaque
   * demande porte celle du plan du propriétaire du projet (#services/plan_enforcement).
   */
  timeoutMs: DEFAULT_COMPILE_TIMEOUT_MS,
  /** Au-delà du timeout de la compilation : synchronisation, envoi des sorties, arrêt de la précédente. */
  gatewayMarginMs: 90_000,
  /** Comptage de mots par le gateway : délai de texcount, attente d'une place sur l'agent. */
  wordCountTimeoutMs: WORD_COUNT_TIMEOUT_MS + 45_000,
  /** Comptage de mots par le Worker, réveil du conteneur compris (Cloudflare coupe à 100 s). */
  workerWordCountTimeoutMs: 95_000,
  /** SyncTeX, arrêt, vidage du cache. */
  shortCallTimeoutMs: 30_000,
  /** pdf.js lit le PDF par requêtes Range pendant toute la session : URL valable 1 heure. */
  outputUrlTtlSeconds: 60 * 60,
}

export default compileConfig
