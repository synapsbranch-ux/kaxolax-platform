import { markdownImportBodySchema } from '@kaxolax/contracts'
import { inject } from '@adonisjs/core'
import type { HttpContext } from '@adonisjs/core/http'
import ClaudeService from '#services/claude/claude_service'
import CompileGateway from '#services/compile_gateway'
import CompileWorkerClient from '#services/compile_worker'
import { importMarkdown } from '#services/markdown_import_service'
import ObjectStorage from '#services/object_storage'
import RealtimeClient from '#services/realtime_client'
import { validateWithZod } from '#validators/zod'

@inject()
export default class MarkdownImportsController {
  constructor(
    private readonly gateway: CompileGateway,
    private readonly worker: CompileWorkerClient,
    private readonly realtime: RealtimeClient,
    private readonly storage: ObjectStorage,
    private readonly claude: ClaudeService,
  ) {}

  /**
   * `POST /projects/:id/convert/markdown` (permission `edit` : éditeur et propriétaire). Corps
   * `markdownImportBodySchema`, réponse `markdownImportResponseSchema` (201 si des fichiers ont
   * été créés). Erreurs : 404 source introuvable, 409 `E_NAME_TAKEN`, 422 `E_CONVERT_FAILED`,
   * `E_NOT_MARKDOWN`, `E_MARKDOWN_TOO_LARGE`, `E_INVALID_LATEX`, 403 `E_PLAN_LIMIT` (stockage,
   * crédits IA) ou `E_AI_DISABLED`, 429 `E_CONVERT_BUSY`, 503 `E_COMPILE_UNAVAILABLE`.
   */
  async store({ params, auth, request, response }: HttpContext) {
    const user = auth.getUserOrFail()
    const body = validateWithZod(markdownImportBodySchema, request.body())
    const result = await importMarkdown(
      {
        gateway: this.gateway,
        worker: this.worker,
        realtime: this.realtime,
        storage: this.storage,
        claude: this.claude,
      },
      user,
      String(params.id),
      body,
    )
    const created = result.document !== null || result.media.some((media) => media.created)
    response.status(created && !result.dryRun ? 201 : 200)
    return result
  }
}
