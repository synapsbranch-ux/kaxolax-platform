import { signCallback, type WorkerCallback } from '@kaxolax/contracts'

export interface CallbackOptions {
  url: string
  secret: string
  fetch?: typeof fetch
  attempts?: number
  /** Attente avant la tentative `attempt` (2, 3…), en ms : 1 s, 4 s, 16 s par défaut. */
  delayMs?: (attempt: number) => number
  log?: (message: string, data?: Record<string, unknown>) => void
}

/**
 * Issue d'un rappel : reçu par l'API, refusé (4xx, inutile de réessayer) ou API injoignable
 * (réseau, 429, 5xx après toutes les tentatives : le runner garde un rappel final pour plus tard).
 */
export type CallbackOutcome = 'delivered' | 'refused' | 'unreachable'

/**
 * Rappel signé vers l'API (`POST /api/v1/internal/compile-callbacks`). Nouvelle signature (et
 * horodatage) à chaque tentative ; réessaie sur erreur réseau, 429 et 5xx. Ne lève jamais :
 * l'API reste cohérente sans ce rappel (sondage, puis clôture au timeout).
 */
export async function sendCallback(
  callback: WorkerCallback,
  options: CallbackOptions,
): Promise<CallbackOutcome> {
  const send = options.fetch ?? fetch
  const attempts = options.attempts ?? 4
  const delayMs = options.delayMs ?? ((attempt: number) => 1_000 * 4 ** (attempt - 2))
  const body = JSON.stringify(callback)
  for (let attempt = 1; attempt <= attempts; attempt++) {
    if (attempt > 1) await new Promise((resolve) => setTimeout(resolve, delayMs(attempt)))
    try {
      const response = await send(options.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(await signCallback(body, options.secret)),
        },
        body,
      })
      if (response.ok) return 'delivered'
      if (response.status < 500 && response.status !== 429) {
        options.log?.('callback refused', { status: response.status, buildId: callback.buildId })
        return 'refused'
      }
    } catch (error) {
      options.log?.('callback failed', { error: String(error), buildId: callback.buildId })
    }
  }
  return 'unreachable'
}
