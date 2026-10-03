import {
  createSuggestionInputSchema,
  type DecideSuggestionsResponse,
  decideSuggestionsInputSchema,
  SUGGESTION_DECIDE_MAX,
  type Suggestion as SuggestionEntry,
  type SuggestionResponse,
  type SuggestionsResponse,
  suggestionsQuerySchema,
  updateSuggestionInputSchema,
} from '@kaxolax/contracts'
import { inject } from '@adonisjs/core'
import type { HttpContext } from '@adonisjs/core/http'
import RealtimeClient from '#services/realtime_client'
import {
  createSuggestion,
  decideSuggestions,
  deleteSuggestion,
  listSuggestions,
  showSuggestion,
  SuggestionAlreadyDecidedException,
  SuggestionRealtimeUnavailableException,
  updateSuggestion,
} from '#services/suggestion_service'
import { validateWithZod } from '#validators/zod'

/**
 * Corps JSON tel qu'envoyé : l'analyseur d'AdonisJS retire les espaces aux extrémités de chaque
 * chaîne (`trimWhitespaces`), ce qui changerait un texte proposé ou d'origine (« %» au lieu de
 * « % », saut de ligne final perdu) et le rendrait obsolète à l'acceptation.
 */
function exactBody(request: HttpContext['request']): unknown {
  const raw = request.raw()
  if (raw === null || raw === '') return request.body()
  try {
    return JSON.parse(raw) as unknown
  } catch {
    return request.body()
  }
}

/**
 * Suivi des modifications (contrats dans `packages/contracts/src/suggestions.ts`). Chaque écriture
 * est annoncée sur le document meta du projet une fois la transaction validée :
 * `suggestion.created`, `suggestion.updated` (modification ou retrait par l'auteur) et
 * `suggestion.decided` (acceptées, refusées ou devenues obsolètes), y compris avant une erreur qui
 * suit une écriture validée (acceptation en partie confirmée, modification ou retrait d'une
 * suggestion trouvée déjà appliquée).
 */
@inject()
export default class SuggestionsController {
  constructor(private readonly realtime: RealtimeClient) {}

  /**
   * Suggestion trouvée déjà appliquée par une acceptation interrompue, lors de sa modification ou
   * de son retrait : enregistrée acceptée (ni modifiée ni retirée), annoncée, puis 409.
   */
  private async announceAccepted(
    projectId: string,
    suggestion: SuggestionEntry,
    decidedBy: string,
  ): Promise<never> {
    await this.realtime.publishProjectEvent(projectId, {
      type: 'suggestion.decided',
      decisions: [
        { suggestionId: suggestion.id, documentId: suggestion.documentId, status: 'accepted' },
      ],
      actorId: decidedBy,
    })
    throw new SuggestionAlreadyDecidedException()
  }

  async index({ params, request, auth }: HttpContext): Promise<SuggestionsResponse> {
    const query = validateWithZod(suggestionsQuerySchema, request.qs())
    return listSuggestions(auth.getUserOrFail(), String(params.id), query)
  }

  async show({ params, auth }: HttpContext): Promise<SuggestionResponse> {
    return {
      suggestion: await showSuggestion(
        auth.getUserOrFail(),
        String(params.id),
        String(params.suggestionId),
      ),
    }
  }

  async store({ params, request, auth, response }: HttpContext) {
    const input = validateWithZod(createSuggestionInputSchema, exactBody(request))
    const { project, suggestion } = await createSuggestion(
      auth.getUserOrFail(),
      String(params.id),
      input,
    )
    await this.realtime.publishProjectEvent(project.id, {
      type: 'suggestion.created',
      suggestionId: suggestion.id,
      documentId: suggestion.documentId,
      authorId: suggestion.author.id,
    })
    const result: SuggestionResponse = { suggestion }
    response.status(201).send(result)
  }

  async update({ params, request, auth }: HttpContext): Promise<SuggestionResponse> {
    const input = validateWithZod(updateSuggestionInputSchema, exactBody(request))
    const user = auth.getUserOrFail()
    const { project, suggestion, accepted } = await updateSuggestion(
      user,
      String(params.id),
      String(params.suggestionId),
      input,
      this.realtime,
    )
    if (accepted !== null) await this.announceAccepted(project.id, suggestion, accepted.decidedBy)
    await this.realtime.publishProjectEvent(project.id, {
      type: 'suggestion.updated',
      suggestionId: suggestion.id,
      documentId: suggestion.documentId,
      change: 'edited',
      actorId: user.id,
    })
    return { suggestion }
  }

  async destroy({ params, auth, response }: HttpContext) {
    const user = auth.getUserOrFail()
    const { project, suggestion, accepted } = await deleteSuggestion(
      user,
      String(params.id),
      String(params.suggestionId),
      this.realtime,
    )
    if (accepted !== null) await this.announceAccepted(project.id, suggestion, accepted.decidedBy)
    await this.realtime.publishProjectEvent(project.id, {
      type: 'suggestion.updated',
      suggestionId: suggestion.id,
      documentId: suggestion.documentId,
      change: 'deleted',
      actorId: user.id,
    })
    response.status(204)
  }

  async decide({ params, request, auth }: HttpContext): Promise<DecideSuggestionsResponse> {
    const input = validateWithZod(decideSuggestionsInputSchema, request.body())
    const user = auth.getUserOrFail()
    const result = await decideSuggestions(user, String(params.id), input, this.realtime)
    for (let start = 0; start < result.decided.length; start += SUGGESTION_DECIDE_MAX) {
      await this.realtime.publishProjectEvent(result.project.id, {
        type: 'suggestion.decided',
        decisions: result.decided.slice(start, start + SUGGESTION_DECIDE_MAX),
        actorId: user.id,
      })
    }
    // Acceptations confirmées enregistrées et annoncées ; les autres restent ouvertes.
    if (!result.complete) throw new SuggestionRealtimeUnavailableException()
    return {
      results: result.results,
      suggestions: result.suggestions,
      remaining: result.remaining,
    }
  }
}
