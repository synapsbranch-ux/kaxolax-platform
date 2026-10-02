import { canEdit, compileProjectBodySchema } from '@kaxolax/contracts'
import { inject } from '@adonisjs/core'
import type { HttpContext } from '@adonisjs/core/http'
import compileConfig from '#config/compile'
import {
  cancelActiveBuild,
  enqueueCompile,
  lastBuildWithOutputs,
} from '#services/async_compile_service'
import CompileGateway from '#services/compile_gateway'
import { compileProject, lastCompile } from '#services/compile_service'
import CompileWorkerClient from '#services/compile_worker'
import { createVersionSafely } from '#services/history_service'
import ObjectStorage, { CompileOutputStorage } from '#services/object_storage'
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
    private readonly worker: CompileWorkerClient,
    private readonly storage: ObjectStorage,
  ) {}

  private get async() {
    return compileConfig.backend === 'cloudflare'
  }

  /**
   * Tout membre du projet peut compiler : la compilation ne modifie pas le contenu. Corps
   * facultatif : `{ options: { draft?, haltOnFirstError? } }`. En mode `cloudflare`, réponse 202
   * `{ buildId, status }` (`queued`, ou `preparing` pendant le réveil du conteneur) ; le résultat
   * arrive par le service temps réel (ou `GET …/builds/:buildId`).
   */
  async compile({ params, auth, request, response }: HttpContext) {
    const user = auth.getUserOrFail()
    const { project, role } = await projectFor(user, String(params.id), 'viewer')
    const body = validateWithZod(compileProjectBodySchema, request.body())
    // Compilation manuelle (pas l'auto-compilation) d'un rédacteur : une version de l'historique,
    // au mieux, une fois la compilation acceptée (un refus ou un lecteur n'en crée pas).
    const recordVersion = async () => {
      if (body.trigger === 'auto' || !canEdit(role)) return
      await createVersionSafely({ storage: this.storage, realtime: this.realtime }, project.id, {
        kind: 'compile',
        actorId: user.id,
      })
    }
    if (this.async) {
      const deps = { worker: this.worker, realtime: this.realtime, outputs: this.outputs }
      const accepted = await enqueueCompile(deps, user, project, body.options)
      await recordVersion()
      response.status(202)
      return accepted
    }
    const result = await compileProject(
      { gateway: this.gateway, realtime: this.realtime, outputs: this.outputs },
      user,
      project,
      body.options,
    )
    await recordVersion()
    return result
  }

  async stop({ params, auth }: HttpContext) {
    const { project } = await projectFor(auth.getUserOrFail(), String(params.id), 'viewer')
    if (this.async) {
      return {
        stopped: await cancelActiveBuild(
          { worker: this.worker, realtime: this.realtime },
          project.id,
        ),
      }
    }
    return { stopped: await this.gateway.stop(project.id) }
  }

  /** Dernière compilation (PDF affiché dès l'ouverture du projet), ou null. */
  async last({ params, auth }: HttpContext) {
    const { project } = await projectFor(auth.getUserOrFail(), String(params.id), 'viewer')
    return { compile: await lastCompile(this.outputs, project.id) }
  }

  async clearCache({ params, auth }: HttpContext) {
    const { project } = await projectFor(auth.getUserOrFail(), String(params.id), 'viewer')
    if (this.async) return { cleared: await this.worker.clearCache(project.id) }
    return { cleared: await this.gateway.clearCache(project.id) }
  }

  async synctexCode({ params, request, auth }: HttpContext) {
    const query = await request.validateUsing(synctexCodeValidator, { data: request.qs() })
    const { project } = await projectFor(auth.getUserOrFail(), String(params.id), 'viewer')
    const position = { ...query, column: query.column ?? 0 }
    if (this.async) {
      const buildId = await lastBuildWithOutputs(project.id)
      return this.worker.synctexFromCode(project.id, { ...position, buildId })
    }
    return this.gateway.synctexFromCode(project.id, position)
  }

  /**
   * Du PDF vers le code. SyncTeX peut désigner un fichier généré (étiquette de citation venue de
   * output.bbl, par exemple) : seules les positions dans un document du projet sont renvoyées.
   */
  async synctexPdf({ params, request, auth }: HttpContext) {
    const query = await request.validateUsing(synctexPdfValidator, { data: request.qs() })
    const { project } = await projectFor(auth.getUserOrFail(), String(params.id), 'viewer')
    const { code } = this.async
      ? await this.worker.synctexFromPdf(project.id, {
          ...query,
          buildId: await lastBuildWithOutputs(project.id),
        })
      : await this.gateway.synctexFromPdf(project.id, query)
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
