import {
  type ZoteroCollectionsResponse,
  type ZoteroConnectionResponse,
  zoteroCallbackQuerySchema,
  zoteroLibraryIdSchema,
  type ZoteroLibrariesResponse,
  zoteroLibraryTypeSchema,
} from '@kaxolax/contracts'
import { inject } from '@adonisjs/core'
import type { HttpContext } from '@adonisjs/core/http'
import ZoteroClient from '#services/zotero/client'
import {
  completeZoteroConnection,
  disconnectZotero,
  serializeZoteroConnection,
  startZoteroConnection,
  zoteroAccountOf,
  zoteroCollections,
  zoteroLibraries,
} from '#services/zotero/connection'
import { validateWithZod } from '#validators/zod'

/**
 * Connexion du compte à Zotero (OAuth 1.0a) et bibliothèques accessibles (contrats :
 * `packages/contracts/src/zotero.ts`). La clé d'API ne sort jamais de l'API.
 */
@inject()
export default class ZoteroController {
  constructor(private readonly zotero: ZoteroClient) {}

  async show({ auth }: HttpContext): Promise<ZoteroConnectionResponse> {
    const account = await zoteroAccountOf(auth.getUserOrFail())
    return {
      available: this.zotero.configured,
      connection: account === null ? null : serializeZoteroConnection(account),
    }
  }

  async connect({ auth, response }: HttpContext) {
    const user = auth.getUserOrFail()
    const { sessionId } = auth.use('clerk').getClaimsOrFail()
    const body = await startZoteroConnection(this.zotero, user, sessionId)
    response.header('cache-control', 'no-store')
    return body
  }

  /** Rappel de zotero.org, relayé par la page web `/integrations/zotero/callback`. */
  async callback({ auth, request, response }: HttpContext) {
    const query = validateWithZod(zoteroCallbackQuerySchema, request.qs())
    const user = auth.getUserOrFail()
    const { sessionId } = auth.use('clerk').getClaimsOrFail()
    const connection = await completeZoteroConnection(this.zotero, user, sessionId, query)
    response.header('cache-control', 'no-store')
    return { connection }
  }

  async destroy({ auth, response }: HttpContext) {
    await disconnectZotero(this.zotero, auth.getUserOrFail())
    response.noContent()
  }

  async libraries({ auth }: HttpContext): Promise<ZoteroLibrariesResponse> {
    return { libraries: await zoteroLibraries(this.zotero, auth.getUserOrFail()) }
  }

  async collections({ auth, params }: HttpContext): Promise<ZoteroCollectionsResponse> {
    const type = validateWithZod(zoteroLibraryTypeSchema, params.type)
    const id = validateWithZod(zoteroLibraryIdSchema, params.libraryId)
    return { collections: await zoteroCollections(this.zotero, auth.getUserOrFail(), { type, id }) }
  }
}
