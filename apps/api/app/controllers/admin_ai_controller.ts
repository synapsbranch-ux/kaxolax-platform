import type { AiHealthResponse } from '@kaxolax/contracts'
import { inject } from '@adonisjs/core'
import ClaudeService from '#services/claude/claude_service'

/** Admin : santé de l'IA (clé, modèle accessible, latence), sans consommer de tokens. */
@inject()
export default class AdminAiController {
  constructor(private readonly claude: ClaudeService) {}

  async health(): Promise<AiHealthResponse> {
    return this.claude.health()
  }
}
