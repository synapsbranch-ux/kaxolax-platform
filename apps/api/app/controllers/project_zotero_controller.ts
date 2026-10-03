import {
  addZoteroCitationInputSchema,
  type AddZoteroCitationResponse,
  linkZoteroInputSchema,
  type ProjectZoteroResponse,
  type ZoteroSearchResponse,
  zoteroSearchQuerySchema,
  zoteroSyncInputSchema,
  type ZoteroSyncResponse,
} from '@kaxolax/contracts'
import { inject } from '@adonisjs/core'
import type { HttpContext } from '@adonisjs/core/http'
import RealtimeClient from '#services/realtime_client'
import ZoteroClient from '#services/zotero/client'
import {
  addZoteroCitation,
  linkProjectToZotero,
  projectZoteroLink,
  searchProjectZotero,
  syncProjectZotero,
  unlinkProjectFromZotero,
  type ZoteroDependencies,
} from '#services/zotero/project_zotero'
import { validateWithZod } from '#validators/zod'

/**
 * Lien Zotero d'un projet, synchronisation du `.bib` et sélecteur de citations (contrats :
 * `packages/contracts/src/zotero.ts`). Lecture du lien : tout membre ; le reste : `edit`.
 */
@inject()
export default class ProjectZoteroController {
  constructor(
    private readonly zotero: ZoteroClient,
    private readonly realtime: RealtimeClient,
  ) {}

  private get deps(): ZoteroDependencies {
    return { zotero: this.zotero, realtime: this.realtime }
  }

  async show({ auth, params }: HttpContext): Promise<ProjectZoteroResponse> {
    const link = await projectZoteroLink(auth.getUserOrFail(), String(params.id))
    return { available: this.zotero.configured, link }
  }

  async update({ auth, params, request }: HttpContext): Promise<ProjectZoteroResponse> {
    const input = validateWithZod(linkZoteroInputSchema, request.body())
    const link = await linkProjectToZotero(
      this.deps,
      auth.getUserOrFail(),
      String(params.id),
      input,
    )
    return { available: true, link }
  }

  async destroy({ auth, params, response }: HttpContext) {
    await unlinkProjectFromZotero(this.deps, auth.getUserOrFail(), String(params.id))
    response.noContent()
  }

  async sync({ auth, params, request }: HttpContext): Promise<ZoteroSyncResponse> {
    const { trigger } = validateWithZod(zoteroSyncInputSchema, request.body())
    return syncProjectZotero(this.deps, auth.getUserOrFail(), String(params.id), trigger)
  }

  async search({ auth, params, request }: HttpContext): Promise<ZoteroSearchResponse> {
    const { q } = validateWithZod(zoteroSearchQuerySchema, request.qs())
    const items = await searchProjectZotero(this.deps, auth.getUserOrFail(), String(params.id), q)
    return { items }
  }

  async addCitation({ auth, params, request }: HttpContext): Promise<AddZoteroCitationResponse> {
    const { itemKey } = validateWithZod(addZoteroCitationInputSchema, request.body())
    return addZoteroCitation(this.deps, auth.getUserOrFail(), String(params.id), itemKey)
  }
}
