import { type WarmCompilerResponse } from '@kaxolax/contracts'
import { inject } from '@adonisjs/core'
import type { HttpContext } from '@adonisjs/core/http'
import compileConfig from '#config/compile'
import { BuildNotFoundException, buildState } from '#services/async_compile_service'
import CompileWorkerClient from '#services/compile_worker'
import { reserveCompiler } from '#services/compiler_quota'
import { CompileOutputStorage } from '#services/object_storage'
import { isUuid, projectFor } from '#services/project_access'
import RealtimeClient from '#services/realtime_client'

/** Compilation asynchrone : état d'une compilation (repli par sondage) et réveil du compilateur. */
@inject()
export default class BuildsController {
  constructor(
    private readonly worker: CompileWorkerClient,
    private readonly outputs: CompileOutputStorage,
    private readonly realtime: RealtimeClient,
  ) {}

  async show({ params, auth }: HttpContext) {
    const { project } = await projectFor(auth.getUserOrFail(), String(params.id), 'viewer')
    const buildId = String(params.buildId)
    if (!isUuid(buildId)) throw new BuildNotFoundException()
    return {
      build: await buildState(
        { outputs: this.outputs, realtime: this.realtime },
        project.id,
        buildId,
      ),
    }
  }

  /**
   * Appelée à l'ouverture de l'éditeur : réveille le conteneur du projet pour que la première
   * compilation n'attende pas son démarrage. Sans effet en mode `gateway`. Plafonné par
   * utilisateur (429 `E_TOO_MANY_COMPILERS`, voir `reserveCompiler`).
   */
  async warm({ params, auth, response }: HttpContext): Promise<WarmCompilerResponse> {
    const user = auth.getUserOrFail()
    const { project } = await projectFor(user, String(params.id), 'viewer')
    if (compileConfig.backend !== 'cloudflare') return { status: 'unsupported' }
    await reserveCompiler(user.id, project.id)
    await this.worker.warm(project.id)
    response.status(202)
    return { status: 'warming' }
  }
}
