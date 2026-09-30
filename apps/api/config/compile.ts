import { DEFAULT_COMPILE_TIMEOUT_MS } from '@kaxolax/contracts'
import env from '#start/env'

/** Compilation : compile-gateway, délais et durée de validité des URL de sortie. */
const compileConfig = {
  gatewayUrl: env.get('COMPILE_GATEWAY_URL'),
  internalToken: env.get('INTERNAL_TOKEN'),
  timeoutMs: DEFAULT_COMPILE_TIMEOUT_MS,
  /** Au-delà du timeout de la compilation : synchronisation, envoi des sorties, arrêt de la précédente. */
  gatewayMarginMs: 90_000,
  /** SyncTeX, arrêt, vidage du cache. */
  shortCallTimeoutMs: 30_000,
  /** pdf.js lit le PDF par requêtes Range pendant toute la session : URL valable 1 heure. */
  outputUrlTtlSeconds: 60 * 60,
}

export default compileConfig
