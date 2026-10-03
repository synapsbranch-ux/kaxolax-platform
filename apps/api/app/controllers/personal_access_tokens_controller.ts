import {
  type CreatedPersonalAccessTokenResponse,
  createPersonalAccessTokenInputSchema,
  type PersonalAccessTokensResponse,
} from '@kaxolax/contracts'
import type { HttpContext } from '@adonisjs/core/http'
import {
  createPersonalAccessToken,
  listPersonalAccessTokens,
  revokePersonalAccessToken,
  serializePersonalAccessToken,
} from '#services/personal_access_tokens'
import { validateWithZod } from '#validators/zod'

/**
 * Jetons d'accès personnels du compte connecté (contrats : `packages/contracts/src/tokens.ts`).
 * Le secret n'est renvoyé qu'à la création.
 */
export default class PersonalAccessTokensController {
  async index({ auth }: HttpContext): Promise<PersonalAccessTokensResponse> {
    const tokens = await listPersonalAccessTokens(auth.getUserOrFail())
    return { tokens: tokens.map(serializePersonalAccessToken) }
  }

  async store({ request, response, auth }: HttpContext) {
    const input = validateWithZod(createPersonalAccessTokenInputSchema, request.body())
    const { token, secret } = await createPersonalAccessToken(auth.getUserOrFail(), input)
    const body: CreatedPersonalAccessTokenResponse = {
      token: serializePersonalAccessToken(token),
      secret,
    }
    // Jamais en cache : la réponse porte le secret.
    response.header('cache-control', 'no-store')
    response.created(body)
  }

  async destroy({ params, auth, response }: HttpContext) {
    await revokePersonalAccessToken(auth.getUserOrFail(), String(params.id))
    response.noContent()
  }
}
