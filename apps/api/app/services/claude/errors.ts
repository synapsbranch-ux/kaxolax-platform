import Anthropic from '@anthropic-ai/sdk'
import { type AiDisabledScope } from '@kaxolax/contracts'
import { Exception } from '@adonisjs/core/exceptions'
import type { HttpContext } from '@adonisjs/core/http'

/**
 * Erreurs typées de l'IA (`AI_ERRORS` de @kaxolax/contracts), levées par le service Claude et
 * rendues telles quelles par l'API. Les erreurs du SDK Anthropic sont converties par
 * `fromAnthropicError` (classes typées du SDK, jamais le texte du message).
 */

/** 503 : IA non configurée (`ANTHROPIC_API_KEY` absente) ou clé refusée par l'API Anthropic. */
export class AiUnavailableException extends Exception {
  static override status = 503
  static override code = 'E_AI_UNAVAILABLE'
  static override message = 'The AI assistant is not available'
}

/** 403 : IA désactivée pour le projet ou pour son workspace. */
export class AiDisabledException extends Exception {
  static override status = 403
  static override code = 'E_AI_DISABLED'

  constructor(readonly scope: AiDisabledScope) {
    super(
      scope === 'workspace'
        ? 'The AI assistant is disabled for this workspace'
        : 'The AI assistant is disabled for this project',
    )
  }

  handle(_error: unknown, { response }: HttpContext) {
    response.status(403).send({ code: 'E_AI_DISABLED', message: this.message, scope: this.scope })
  }
}

/** 429 : trop d'appels de cet utilisateur (limite par instance de l'API). */
export class AiRateLimitedException extends Exception {
  static override status = 429
  static override code = 'E_AI_RATE_LIMITED'
  static override message = 'Too many AI requests, try again later'

  constructor(readonly retryAfterSeconds: number) {
    super()
  }

  handle(_error: unknown, { response }: HttpContext) {
    response.header('retry-after', String(this.retryAfterSeconds))
    response.status(429).send({
      code: 'E_AI_RATE_LIMITED',
      message: this.message,
      retryAfterSeconds: this.retryAfterSeconds,
    })
  }
}

/** 503 : API Anthropic surchargée (529) ou limitée (429), après les nouvelles tentatives du SDK. */
export class AiOverloadedException extends Exception {
  static override status = 503
  static override code = 'E_AI_OVERLOADED'
  static override message = 'The AI service is busy, try again in a moment'
}

/** 502 : autre échec de l'API Anthropic (réseau, délai, 5xx, requête refusée). */
export class AiUpstreamException extends Exception {
  static override status = 502
  static override code = 'E_AI_UPSTREAM'
  static override message = 'The AI service failed to answer'
}

/** 422 : le modèle a refusé (`stop_reason` `refusal`), repli serveur compris. */
export class AiRefusedException extends Exception {
  static override status = 422
  static override code = 'E_AI_REFUSED'
  static override message = 'The AI assistant declined this request'

  constructor(readonly category: string | null) {
    super()
  }

  handle(_error: unknown, { response }: HttpContext) {
    response
      .status(422)
      .send({ code: 'E_AI_REFUSED', message: this.message, category: this.category })
  }
}

/** 422 : réponse tronquée (`max_tokens`, contexte plein) là où une réponse complète est exigée. */
export class AiTruncatedException extends Exception {
  static override status = 422
  static override code = 'E_AI_TRUNCATED'
  static override message = 'The AI answer was cut off before the end'

  constructor(readonly stopReason: string) {
    super()
  }
}

/** 499 : appel interrompu (le client est parti, `AbortSignal`). */
export class AiCancelledException extends Exception {
  static override status = 499
  static override code = 'E_AI_CANCELLED'
  static override message = 'The AI request was cancelled'
}

/**
 * Erreur de l'IA correspondant à une erreur du SDK Anthropic, d'après sa classe typée (et le
 * `type` structuré d'une erreur reçue en cours de flux) ; toute autre erreur est rendue telle quelle.
 * Les 429 et 5xx ont déjà été retentés par le SDK.
 */
export function fromAnthropicError(error: unknown): unknown {
  const options = { cause: error }
  // Sous-classes d'APIError : à tester d'abord.
  if (error instanceof Anthropic.APIUserAbortError) {
    return new AiCancelledException(undefined, options)
  }
  if (error instanceof Anthropic.APIConnectionError) {
    return new AiUpstreamException(undefined, options)
  }
  if (
    error instanceof Anthropic.AuthenticationError ||
    error instanceof Anthropic.PermissionDeniedError
  ) {
    return new AiUnavailableException(undefined, options)
  }
  if (error instanceof Anthropic.RateLimitError) {
    return new AiOverloadedException(undefined, options)
  }
  if (error instanceof Anthropic.APIError) {
    // 529 (surcharge) en réponse HTTP, ou événement `error` en cours de flux (sans statut).
    const overloaded =
      error.status === 529 || error.type === 'overloaded_error' || error.type === 'rate_limit_error'
    return overloaded
      ? new AiOverloadedException(undefined, options)
      : new AiUpstreamException(undefined, options)
  }
  return error
}
