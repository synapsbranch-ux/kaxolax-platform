import { HISTORY_IDLE_SECONDS } from '@kaxolax/contracts'
import env from '#start/env'

/** Historique du projet : versions automatiques et purge selon la conservation du plan. */
const historyConfig = {
  /** Délai sans modification avant une version automatique. */
  idleSeconds: HISTORY_IDLE_SECONDS,
  /** Intervalle du balayage des versions automatiques dans le processus web (0 : désactivé). */
  sweepSeconds: env.get('HISTORY_SWEEP_SECONDS', 30),
  /** Délai avant un nouvel essai de version automatique après un échec. */
  retrySeconds: env.get('HISTORY_RETRY_SECONDS', 600),
  /** Intervalle de la purge des versions expirées (0 : désactivée). */
  purgeSeconds: env.get('HISTORY_PURGE_SECONDS', 3600),
}

export default historyConfig
