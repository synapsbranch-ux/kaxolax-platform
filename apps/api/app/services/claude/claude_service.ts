import type Anthropic from '@anthropic-ai/sdk'
import type { BetaMessageStreamParams } from '@anthropic-ai/sdk/resources/beta/messages/messages'
import { AI_DEFAULT_MODEL, type AiEffort, type AiHealthResponse } from '@kaxolax/contracts'
import { inject } from '@adonisjs/core'
import { Exception } from '@adonisjs/core/exceptions'
import logger from '@adonisjs/core/services/logger'
import db from '@adonisjs/lucid/services/db'
import AiUsage from '#models/ai_usage'
import type User from '#models/user'
import aiConfig from '#config/ai'
import {
  type CreditReservation,
  releaseCredits,
  renewCredits,
  reserveCredits,
  settleCredits,
} from '#services/ai_credits'
import { assertAiEnabled } from '#services/ai_settings'
import ClaudeClient, { type ClaudeStreamOutcome } from '#services/claude/client'
import {
  AiRefusedException,
  AiTruncatedException,
  AiUnavailableException,
  fromAnthropicError,
} from '#services/claude/errors'
import { type ClaudeOperation, OPERATION_SETTINGS } from '#services/claude/operations'
import {
  callCost,
  estimateCostMicros,
  outputTokensWithin,
  type TokenUsage,
  visibleOutputTokens,
  worstCaseCostMicros,
} from '#services/claude/pricing'
import { aiRateLimiter } from '#services/claude/rate_limiter'

/**
 * Enveloppe unique des appels à Claude : applique les règles de l'API Anthropic retenues par
 * Kaxolax et mesure chaque appel.
 *
 * - modèle `claude-opus-5-5`, réflexion adaptative (`thinking` jamais désactivé, jamais de
 *   budget), profondeur `output_config.effort` fixée explicitement par opération ;
 * - streaming (`client.beta.messages.stream`, `finalMessage()`), nouvelles tentatives du SDK ;
 * - repli serveur en cas de refus : beta `server-side-fallback-2026-07-01` + `fallbacks: "default"` ;
 * - cache du prompt : outils puis système figés en tête (`cache_control` éphémère sur le dernier
 *   bloc système), plus le cache automatique de la fin de conversation ; rien de variable avant
 *   le point de cache ;
 * - outils : `strict: true`, `tool_choice` `auto` seulement, entrées à valider par l'appelant
 *   avant exécution (streaming des entrées activé) ;
 * - `stop_reason` vérifié avant de lire le contenu (`refusal`, `max_tokens`) ;
 * - erreurs du SDK converties d'après leurs classes typées ;
 * - avant l'appel : IA configurée (503), activée pour le projet et son workspace (403), limite
 *   de débit par utilisateur (429), coût maximal réservé sur les crédits (403 `E_PLAN_LIMIT`,
 *   `max_tokens` réduit au solde) ; après : une ligne ai_usage (tokens, cache, coût) et le
 *   règlement des crédits, dans une même transaction.
 */

/** Outil défini par l'appelant : schéma JSON figé (pas de `strict`, ajouté ici). */
export type ClaudeTool = Omit<
  Anthropic.Beta.BetaTool,
  'strict' | 'cache_control' | 'eager_input_streaming' | 'type'
>

export interface ClaudeRequest {
  /** Utilisateur qui lance l'action : droits, limite de débit et crédits (son plan). */
  user: User
  operation: ClaudeOperation
  /** Projet concerné (accès déjà vérifié par l'appelant) : IA activée exigée, comptage. */
  project?: { id: string } | null
  /** Prompt système figé : identique d'un appel à l'autre (ni date ni identifiant). */
  system: string
  /** Outils, dans un ordre stable. */
  tools?: readonly ClaudeTool[]
  /** Historique (blocs renvoyés tels quels) puis le nouveau message de l'utilisateur. */
  messages: Anthropic.Beta.BetaMessageParam[]
  /** Resserre le plafond de sortie de l'opération (jamais au-delà). */
  maxTokens?: number
  /** Remplace la profondeur de l'opération. */
  effort?: AiEffort
  /** Message de l'assistant enregistré pour cet appel (ai_usage). */
  aiMessageId?: string | null
  /** Accepte une réponse texte tronquée (`max_tokens`) au lieu de lever `AiTruncatedException`. */
  acceptTruncated?: boolean
  onEvent?: (event: Anthropic.Beta.BetaRawMessageStreamEvent) => void
  signal?: AbortSignal
}

export interface ClaudeResult {
  /** Réponse complète de l'API (blocs à enregistrer et renvoyer tels quels). */
  message: Anthropic.Beta.BetaMessage
  stopReason: Anthropic.Beta.BetaStopReason | null
  /** Texte des blocs `text`, dans l'ordre. */
  text: string
  /** Réponse coupée (`max_tokens`), acceptée par l'appelant. */
  truncated: boolean
  /** Modèle qui a servi la réponse (repli serveur compris). */
  model: string
  fallbackUsed: boolean
  usage: TokenUsage
  costMicros: number
  /** Ligne ai_usage de l'appel ; null si son écriture a échoué (crédits réglés quand même). */
  usageId: string | null
}

/** Beta et mode du repli serveur en cas de refus (forme « default » : routage par catégorie). */
export const FALLBACK_BETA = 'server-side-fallback-2026-07-01'

@inject()
export default class ClaudeService {
  constructor(private readonly client: ClaudeClient) {}

  /** Clé de l'API présente. */
  get configured(): boolean {
    return this.client.configured
  }

  /**
   * Paramètres de la requête : préfixe figé (outils, système) mis en cache, réflexion adaptative,
   * profondeur explicite, repli serveur.
   */
  buildParams(request: ClaudeRequest): BetaMessageStreamParams {
    const settings = OPERATION_SETTINGS[request.operation]
    const maxTokens = Math.min(request.maxTokens ?? settings.maxTokens, settings.maxTokens)
    const tools = (request.tools ?? []).map((tool) => ({
      ...tool,
      strict: true,
      eager_input_streaming: true,
    }))
    return {
      model: AI_DEFAULT_MODEL,
      max_tokens: maxTokens,
      betas: [FALLBACK_BETA],
      fallbacks: 'default',
      thinking: { type: 'adaptive' },
      output_config: { effort: request.effort ?? settings.effort },
      system: [{ type: 'text', text: request.system, cache_control: { type: 'ephemeral' } }],
      ...(tools.length > 0 ? { tools, tool_choice: { type: 'auto' } } : {}),
      messages: request.messages,
      // Point de cache automatique sur le dernier bloc : la conversation déjà envoyée est relue
      // depuis le cache au tour suivant.
      cache_control: { type: 'ephemeral' },
      // Identifiant opaque (détection d'abus côté Anthropic), jamais d'email.
      metadata: { user_id: request.user.id },
    }
  }

  /** Lève avant tout appel : IA non configurée (503) ou désactivée (403). Renvoie le workspace. */
  async assertUsable(project?: { id: string } | null): Promise<string | null> {
    if (!this.client.configured) throw new AiUnavailableException()
    return project ? assertAiEnabled(project) : null
  }

  /** Un appel à Claude, mesuré et décompté (voir l'en-tête du module). */
  async run(request: ClaudeRequest): Promise<ClaudeResult> {
    // Pas de préremplissage de la réponse (refusé par le modèle) : erreur de programmation.
    if (request.messages.length === 0 || request.messages.at(-1)?.role === 'assistant') {
      throw new Error('The conversation sent to Claude must end with a user turn (no prefill)')
    }
    const workspaceId = await this.assertUsable(request.project)
    const release = aiRateLimiter.acquire(request.user.id)
    try {
      const settings = OPERATION_SETTINGS[request.operation]
      const requested = this.buildParams(request)
      const minOutput = Math.min(requested.max_tokens, settings.expectedOutputTokens)
      // Coût maximal réservé (`max_tokens` entier au prix le plus élevé, repli serveur compris).
      // Solde plus faible mais suffisant pour la sortie attendue : réservation ramenée au solde
      // et `max_tokens` réduit d'autant. La somme des appels simultanés reste dans le plan.
      const reservation = await reserveCredits(
        request.user,
        'ai',
        worstCaseCostMicros(requested, requested.max_tokens),
        { minimum: worstCaseCostMicros(requested, minOutput) },
      )
      const params: BetaMessageStreamParams = {
        ...requested,
        max_tokens: Math.max(
          minOutput,
          outputTokensWithin(requested, reservation.amount, requested.max_tokens),
        ),
      }
      // Appel plus long que la durée de vie de la réservation : prolongée tant qu'il tourne.
      const renewal = setInterval(() => {
        renewCredits(reservation).catch((error: unknown) => {
          logger.warn({ err: error, reservationId: reservation.id }, 'ai credits not renewed')
        })
      }, aiConfig.reservationRenewSeconds * 1000)
      renewal.unref()
      try {
        return await this.call(request, params, workspaceId, reservation, minOutput)
      } finally {
        clearInterval(renewal)
      }
    } finally {
      release()
    }
  }

  /** Requête en streaming puis comptage (crédits réservés). */
  private async call(
    request: ClaudeRequest,
    params: BetaMessageStreamParams,
    workspaceId: string | null,
    reservation: CreditReservation,
    minOutput: number,
  ): Promise<ClaudeResult> {
    let outcome: ClaudeStreamOutcome
    try {
      outcome = await this.client.stream(params, {
        signal: request.signal,
        onEvent: request.onEvent,
      })
    } catch (error) {
      await releaseCredits(reservation)
      throw error
    }
    if (!outcome.ok) {
      // Erreur ou client parti après le début de la réponse : le début reçu est facturé. L'usage
      // du flux ne compte la sortie qu'à la fin (`message_delta`) : sortie estimée d'après le
      // contenu reçu, et au moins le coût attendu (réflexion non visible), dans la réservation.
      if (outcome.partial) {
        const partial = outcome.partial
        const output = Math.min(
          params.max_tokens,
          Math.max(partial.usage.output_tokens, visibleOutputTokens(partial.content)),
        )
        await this.record(
          request,
          workspaceId,
          reservation,
          { ...partial, usage: { ...partial.usage, output_tokens: output } },
          outcome,
          Math.min(reservation.amount, estimateCostMicros(AI_DEFAULT_MODEL, params, minOutput)),
        )
      } else {
        await releaseCredits(reservation)
      }
      const mapped = fromAnthropicError(outcome.error)
      logger.warn(
        {
          userId: request.user.id,
          operation: request.operation,
          requestId: outcome.requestId,
          code: mapped instanceof Exception ? mapped.code : undefined,
          err: outcome.error,
        },
        'claude call failed',
      )
      throw mapped
    }
    const recorded = await this.record(request, workspaceId, reservation, outcome.message, outcome)
    return this.checkStop(request, outcome.message, recorded)
  }

  /**
   * Enregistre l'usage de l'appel et règle les crédits, dans une même transaction. `floorMicros` :
   * montant facturé au minimum (réponse interrompue). Ne lève pas : la réponse reçue est rendue
   * même si l'écriture échoue (journal d'erreur, crédits réglés à part pour ne rien perdre).
   */
  private async record(
    request: ClaudeRequest,
    workspaceId: string | null,
    reservation: CreditReservation,
    message: Anthropic.Beta.BetaMessage,
    outcome: ClaudeStreamOutcome,
    floorMicros = 0,
  ): Promise<{ id: string | null; usage: TokenUsage; costMicros: number }> {
    const cost = callCost(message)
    if (cost.unknownModels.length > 0) {
      logger.warn(
        { models: cost.unknownModels },
        'claude model without pricing, highest price used',
      )
    }
    const costMicros = Math.max(cost.costMicros, floorMicros)
    const stopReason = outcome.ok ? message.stop_reason : 'error'
    const details = {
      userId: request.user.id,
      operation: request.operation,
      model: message.model,
      inputTokens: cost.totals.inputTokens,
      outputTokens: cost.totals.outputTokens,
      cacheRead: cost.totals.cacheReadInputTokens,
      cacheWrite: cost.totals.cacheCreationInputTokens,
      costMicros,
      stopReason,
      requestId: outcome.requestId,
    }
    let id: string | null = null
    try {
      const row = await db.transaction(async (trx) => {
        const created = await AiUsage.create(
          {
            userId: request.user.id,
            projectId: request.project?.id ?? null,
            workspaceId,
            aiMessageId: request.aiMessageId ?? null,
            operation: request.operation,
            creditKind: 'ai',
            model: message.model,
            inputTokens: cost.totals.inputTokens,
            outputTokens: cost.totals.outputTokens,
            cacheReadInputTokens: cost.totals.cacheReadInputTokens,
            cacheCreationInputTokens: cost.totals.cacheCreationInputTokens,
            costMicros,
            imageCount: 0,
            stopReason,
            requestId: outcome.requestId,
          },
          { client: trx },
        )
        await settleCredits(reservation, costMicros, trx)
        return created
      })
      id = row.id
    } catch (error) {
      // Appel consommé (facturé par Anthropic) : jamais perdu pour les crédits.
      logger.error({ ...details, err: error }, 'claude usage not recorded')
      try {
        await settleCredits(reservation, costMicros)
      } catch (settleError) {
        logger.error(
          { ...details, reservationId: reservation.id, err: settleError },
          'claude credits not settled',
        )
      }
    }
    // Lecture du cache vérifiable dans le journal (`cacheRead` à 0 d'un tour à l'autre : préfixe
    // instable).
    logger.info(details, 'claude call')
    return { id, usage: cost.totals, costMicros }
  }

  /** Vérifie `stop_reason` avant que l'appelant lise le contenu. */
  private checkStop(
    request: ClaudeRequest,
    message: Anthropic.Beta.BetaMessage,
    recorded: { id: string | null; usage: TokenUsage; costMicros: number },
  ): ClaudeResult {
    const stopReason = message.stop_reason
    if (stopReason === 'refusal') {
      throw new AiRefusedException(message.stop_details?.category ?? null)
    }
    const truncated = stopReason === 'max_tokens' || stopReason === 'model_context_window_exceeded'
    // Une entrée d'outil coupée peut sembler valide : jamais exécutée.
    const hasToolUse = message.content.some((block) => block.type === 'tool_use')
    if (truncated && (request.acceptTruncated !== true || hasToolUse)) {
      throw new AiTruncatedException(stopReason)
    }
    const text = message.content
      .flatMap((block) => (block.type === 'text' ? [block.text] : []))
      .join('')
    const fallbackUsed = (message.usage.iterations ?? []).some(
      (iteration) => iteration.type === 'fallback_message',
    )
    return {
      message,
      stopReason,
      text,
      truncated,
      model: message.model,
      fallbackUsed,
      usage: recorded.usage,
      costMicros: recorded.costMicros,
      usageId: recorded.id,
    }
  }

  /** Santé de l'IA pour l'admin : clé, modèle accessible (API Models, sans tokens), latence. */
  async health(): Promise<AiHealthResponse> {
    const checkedAt = new Date().toISOString()
    if (!this.client.configured) {
      return {
        configured: false,
        model: AI_DEFAULT_MODEL,
        ok: false,
        latencyMs: null,
        error: 'E_AI_UNAVAILABLE',
        checkedAt,
      }
    }
    const started = performance.now()
    try {
      await this.client.retrieveModel(AI_DEFAULT_MODEL)
      return {
        configured: true,
        model: AI_DEFAULT_MODEL,
        ok: true,
        latencyMs: Math.round(performance.now() - started),
        error: null,
        checkedAt,
      }
    } catch (error) {
      const mapped = fromAnthropicError(error)
      logger.warn({ err: error }, 'claude health check failed')
      return {
        configured: true,
        model: AI_DEFAULT_MODEL,
        ok: false,
        latencyMs: Math.round(performance.now() - started),
        error: mapped instanceof Exception && mapped.code ? mapped.code : 'E_AI_UPSTREAM',
        checkedAt,
      }
    }
  }
}
