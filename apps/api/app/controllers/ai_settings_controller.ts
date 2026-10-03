import type { ProjectAiSettings, WorkspaceAiSettings } from '@kaxolax/contracts'
import { updateAiSettingsInputSchema } from '@kaxolax/contracts'
import { inject } from '@adonisjs/core'
import type { HttpContext } from '@adonisjs/core/http'
import {
  projectAiSettings,
  setProjectAi,
  setWorkspaceAi,
  workspaceAiSettings,
} from '#services/ai_settings'
import ClaudeClient from '#services/claude/client'
import { validateWithZod } from '#validators/zod'

/**
 * Activation de l'IA (contrats : `packages/contracts/src/ai.ts`) : lecture par tout membre,
 * modification par le propriétaire du projet (permission `manageAi`) ou du workspace.
 */
@inject()
export default class AiSettingsController {
  constructor(private readonly claude: ClaudeClient) {}

  async showProject({ params, auth }: HttpContext): Promise<ProjectAiSettings> {
    return projectAiSettings(auth.getUserOrFail(), String(params.id), this.claude.configured)
  }

  async updateProject({ params, request, auth }: HttpContext): Promise<ProjectAiSettings> {
    const { enabled } = validateWithZod(updateAiSettingsInputSchema, request.body())
    return setProjectAi(auth.getUserOrFail(), String(params.id), enabled, this.claude.configured)
  }

  async showWorkspace({ params, auth }: HttpContext): Promise<WorkspaceAiSettings> {
    return workspaceAiSettings(auth.getUserOrFail(), String(params.id), this.claude.configured)
  }

  async updateWorkspace({ params, request, auth }: HttpContext): Promise<WorkspaceAiSettings> {
    const { enabled } = validateWithZod(updateAiSettingsInputSchema, request.body())
    return setWorkspaceAi(auth.getUserOrFail(), String(params.id), enabled, this.claude.configured)
  }
}
