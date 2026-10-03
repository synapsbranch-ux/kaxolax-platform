import { randomUUID } from 'node:crypto'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createProjectFromTemplateSchema,
  filterTemplates,
  type TemplateListResponse,
  templateListQuerySchema,
  type TemplateResponse,
} from '@kaxolax/contracts'
import { inject } from '@adonisjs/core'
import type { HttpContext } from '@adonisjs/core/http'
import ObjectStorage from '#services/object_storage'
import { accountForNewProject } from '#services/entitlements'
import { assertStorageAvailable } from '#services/plan_enforcement'
import { serializeProject } from '#services/project_service'
import RealtimeClient from '#services/realtime_client'
import {
  downloadTemplateZip,
  findTemplate,
  loadTemplateCatalog,
  templateSummary,
} from '#services/template_catalog'
import { createProjectFromZip } from '#services/upload_service'
import { checkNewProjectWorkspace } from '#services/workspace_service'
import { validateWithZod } from '#validators/zod'

/** Mise en cache par le CDN et le navigateur des réponses publiques de la galerie. */
const PUBLIC_CACHE = 'public, max-age=60, stale-while-revalidate=300'

/**
 * Galerie de templates : catalogue public (lecture sans compte) et création d'un projet depuis un
 * template (zip du catalogue passé à l'import zip).
 */
@inject()
export default class TemplatesController {
  constructor(
    private readonly storage: ObjectStorage,
    private readonly realtime: RealtimeClient,
  ) {}

  /** `GET /templates?q=&category=&language=&compiler=` (public). */
  async index({ request, response }: HttpContext): Promise<TemplateListResponse> {
    const query = validateWithZod(templateListQuerySchema, request.qs())
    const catalog = await loadTemplateCatalog()
    const { templates, categories } = filterTemplates(catalog.templates, query)
    response.header('cache-control', PUBLIC_CACHE)
    return {
      templates: templates.map(templateSummary),
      categories,
      generatedAt: catalog.generatedAt,
    }
  }

  /** `GET /templates/:id` (public). */
  async show({ params, response }: HttpContext): Promise<TemplateResponse> {
    const template = await findTemplate(String(params.id))
    response.header('cache-control', PUBLIC_CACHE)
    return { template: templateSummary(template) }
  }

  /**
   * `POST /projects/from-template` : télécharge le zip du template, vérifie sa taille et son
   * sha256 contre le catalogue, puis crée le projet comme l'import zip (stockage du plan vérifié
   * avant le téléchargement, puis sur le contenu extrait), avec le compilateur et le document
   * principal du catalogue.
   */
  async store({ request, auth, response }: HttpContext) {
    const input = validateWithZod(createProjectFromTemplateSchema, request.body())
    const user = auth.getUserOrFail()
    const template = await findTemplate(input.templateId)
    // Refus anticipés, avant tout téléchargement : workspace et taille du zip.
    await checkNewProjectWorkspace(user, input.workspaceId)
    await assertStorageAvailable(
      await accountForNewProject(user, input.workspaceId),
      template.files.zip.bytes,
      { requester: user },
    )

    const zipPath = join(tmpdir(), `kaxolax-template-${randomUUID()}.zip`)
    try {
      await downloadTemplateZip(template, zipPath)
      const project = await createProjectFromZip(this.storage, user, zipPath, {
        name: input.name ?? template.title,
        workspaceId: input.workspaceId,
        compiler: template.compiler,
        mainDocumentPath: template.mainDocument,
      })
      await this.realtime.publishProjectEvent(project.id, {
        type: 'tree.changed',
        reason: 'import',
        actorId: user.id,
        changes: [],
        mainDocumentId: project.mainDocumentId,
      })
      response.created({ project: serializeProject(project, 'owner') })
    } finally {
      await rm(zipPath, { force: true })
    }
  }
}
