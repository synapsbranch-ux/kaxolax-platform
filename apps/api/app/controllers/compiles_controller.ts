import { compileProjectBodySchema } from '@kaxolax/contracts'
import { inject } from '@adonisjs/core'
import type { HttpContext } from '@adonisjs/core/http'
import CompileGateway from '#services/compile_gateway'
import { compileProject, lastCompile } from '#services/compile_service'
import { CompileOutputStorage } from '#services/object_storage'
import { projectFor } from '#services/project_access'
import RealtimeClient from '#services/realtime_client'
import { buildTree } from '#services/tree_service'
import { synctexCodeValidator, synctexPdfValidator } from '#validators/compile'
import { validateWithZod } from '#validators/zod'

@inject()
export default class CompilesController {
  constructor(
    private readonly gateway: CompileGateway,
    private readonly realtime: RealtimeClient,
    private readonly outputs: CompileOutputStorage,
  ) {}

  /**
   * Tout membre du projet peut compiler : la compilation ne modifie pas le contenu. Corps
   * facultatif : `{ options: { draft?, haltOnFirstError? } }`.
   */
  async compile({ params, auth, request }: HttpContext) {
    const user = auth.getUserOrFail()
    const { project } = await projectFor(user, String(params.id), 'viewer')
    const body = validateWithZod(compileProjectBodySchema, request.body())
    return compileProject(
      { gateway: this.gateway, realtime: this.realtime, outputs: this.outputs },
      user,
      project,
      body.options,
    )
  }

  async stop({ params, auth }: HttpContext) {
    const { project } = await projectFor(auth.getUserOrFail(), String(params.id), 'viewer')
    return { stopped: await this.gateway.stop(project.id) }
  }

  /** Dernière compilation (PDF affiché dès l'ouverture du projet), ou null. */
  async last({ params, auth }: HttpContext) {
    const { project } = await projectFor(auth.getUserOrFail(), String(params.id), 'viewer')
    return { compile: await lastCompile(this.outputs, project.id) }
  }

  async clearCache({ params, auth }: HttpContext) {
    const { project } = await projectFor(auth.getUserOrFail(), String(params.id), 'viewer')
    return { cleared: await this.gateway.clearCache(project.id) }
  }

  async synctexCode({ params, request, auth }: HttpContext) {
    const query = await request.validateUsing(synctexCodeValidator, { data: request.qs() })
    const { project } = await projectFor(auth.getUserOrFail(), String(params.id), 'viewer')
    return this.gateway.synctexFromCode(project.id, { ...query, column: query.column ?? 0 })
  }

  /**
   * Du PDF vers le code. SyncTeX peut désigner un fichier généré (étiquette de citation venue de
   * output.bbl, par exemple) : seules les positions dans un document du projet sont renvoyées.
   */
  async synctexPdf({ params, request, auth }: HttpContext) {
    const query = await request.validateUsing(synctexPdfValidator, { data: request.qs() })
    const { project } = await projectFor(auth.getUserOrFail(), String(params.id), 'viewer')
    const { code } = await this.gateway.synctexFromPdf(project.id, query)
    const documents = new Set(
      (await buildTree(project.id)).documents.map((document) => document.path),
    )
    const seen = new Set<string>()
    return {
      code: code.filter((position) => {
        const key = `${position.file}:${String(position.line)}`
        if (!documents.has(position.file) || seen.has(key)) return false
        seen.add(key)
        return true
      }),
    }
  }
}
