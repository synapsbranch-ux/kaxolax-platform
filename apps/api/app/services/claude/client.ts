import Anthropic from '@anthropic-ai/sdk'
import type { BetaMessageStreamParams } from '@anthropic-ai/sdk/resources/beta/messages/messages'
import aiConfig from '#config/ai'
import env from '#start/env'

/** Issue d'une requête en streaming : message final, ou erreur avec le message partiel reçu. */
export type ClaudeStreamOutcome =
  | { ok: true; message: Anthropic.Beta.BetaMessage; requestId: string | null }
  | {
      ok: false
      error: unknown
      /** Message reçu avant l'erreur (usage du début de réponse, facturé), sinon null. */
      partial: Anthropic.Beta.BetaMessage | null
      requestId: string | null
    }

export interface ClaudeStreamOptions {
  /** Interrompt la requête (client parti). */
  signal?: AbortSignal
  /** Chaque événement du flux, dans l'ordre (relais vers le navigateur, tâche 3). */
  onEvent?: (event: Anthropic.Beta.BetaRawMessageStreamEvent) => void
}

let shared: Anthropic | null | undefined

/** Client du SDK créé une seule fois depuis `ANTHROPIC_API_KEY` ; null sans clé. */
function sharedSdk(): Anthropic | null {
  if (shared === undefined) {
    const key = env.get('ANTHROPIC_API_KEY')?.release()
    shared =
      key === undefined || key === ''
        ? null
        : new Anthropic({
            apiKey: key,
            maxRetries: aiConfig.maxRetries,
            timeout: aiConfig.timeoutMs,
          })
  }
  return shared
}

/**
 * Seul point d'appel de l'API Anthropic (SDK officiel `@anthropic-ai/sdk`, jamais d'appel HTTP
 * brut). Injecté par le conteneur : les tests le remplacent (`app.container.swap`) par un client
 * dont le SDK parle à une fausse API. Sans clé, `configured` est faux et aucun appel ne part.
 */
export default class ClaudeClient {
  constructor(private readonly sdk: Anthropic | null = sharedSdk()) {}

  get configured(): boolean {
    return this.sdk !== null
  }

  private requireSdk(): Anthropic {
    if (this.sdk === null) throw new Error('ANTHROPIC_API_KEY is not configured')
    return this.sdk
  }

  /**
   * Requête en streaming (`client.beta.messages.stream`, `finalMessage()`) : ne lève pas, renvoie
   * le message final ou l'erreur du SDK (classes typées) avec le message partiel déjà reçu.
   */
  async stream(
    params: BetaMessageStreamParams,
    options: ClaudeStreamOptions = {},
  ): Promise<ClaudeStreamOutcome> {
    const stream = this.requireSdk().beta.messages.stream(params, { signal: options.signal })
    const { onEvent } = options
    if (onEvent) {
      stream.on('streamEvent', (event) => {
        onEvent(event)
      })
    }
    try {
      const message = await stream.finalMessage()
      return { ok: true, message, requestId: stream.request_id ?? null }
    } catch (error) {
      return {
        ok: false,
        error,
        partial: stream.currentMessage ?? null,
        requestId: stream.request_id ?? null,
      }
    }
  }

  /** Vérifie que la clé est acceptée et le modèle accessible (API Models, sans tokens). */
  async retrieveModel(model: string): Promise<void> {
    await this.requireSdk().models.retrieve(model, null, {
      maxRetries: 0,
      timeout: aiConfig.healthTimeoutMs,
    })
  }
}
