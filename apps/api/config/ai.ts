import { AI_DEFAULT_MODEL } from '@kaxolax/contracts'

/**
 * IA (Claude) : modèle par défaut, nouvelles tentatives et délai des requêtes du SDK, durée de vie
 * d'une réservation de crédits. La clé (`ANTHROPIC_API_KEY`) est lue par `ClaudeClient`.
 */
const aiConfig = {
  /** ID exact, sans suffixe de date. */
  model: AI_DEFAULT_MODEL,
  /** Nouvelles tentatives du SDK (408, 409, 429, 5xx, réseau), attente exponentielle. */
  maxRetries: 2,
  /** Délai d'une requête en streaming (ms) : une réponse longue peut prendre plusieurs minutes. */
  timeoutMs: 10 * 60 * 1000,
  /** Délai de la vérification de santé (API Models, ms), sans nouvelle tentative. */
  healthTimeoutMs: 10_000,
  /**
   * Une réservation de crédits non réglée cesse de compter après ce délai, en secondes : plus
   * long que `timeoutMs` × (`maxRetries` + 1) (30 min). Un appel plus long (flux de sortie non
   * borné par `timeoutMs`) la prolonge toutes les `reservationRenewSeconds` tant qu'il tourne ;
   * seul un processus arrêté pendant l'appel la laisse expirer.
   */
  reservationTtlSeconds: 40 * 60,
  /** Intervalle de prolongation d'une réservation pendant l'appel, en secondes. */
  reservationRenewSeconds: 5 * 60,
} as const

export default aiConfig
