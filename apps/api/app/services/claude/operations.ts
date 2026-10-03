import type { AiEffort, AiOperation } from '@kaxolax/contracts'

/** Opérations servies par Claude (les images bitmap passent par un fournisseur tiers). */
export type ClaudeOperation = Exclude<AiOperation, 'image'>

export interface OperationSettings {
  /** `output_config.effort`, toujours explicite (défaut du modèle : `medium`). */
  readonly effort: AiEffort
  /** Plafond de sortie (streaming : pas de délai HTTP à craindre). */
  readonly maxTokens: number
  /**
   * Sortie attendue : minimum que le solde de crédits doit couvrir (au pire prix) pour lancer
   * l'appel, et plancher facturé d'une réponse interrompue avant sa fin.
   */
  readonly expectedOutputTokens: number
}

/**
 * Réglages par usage : profondeur de réflexion et plafond de sortie. Seul endroit où ils sont
 * fixés ; un appel peut les resserrer, jamais les dépasser.
 */
export const OPERATION_SETTINGS: Readonly<Record<ClaudeOperation, OperationSettings>> = {
  // Conversation avec outils (lire, chercher, proposer) : profondeur moyenne.
  assistant: { effort: 'medium', maxTokens: 32_000, expectedOutputTokens: 4_000 },
  // Reformuler, raccourcir, traduire, corriger une erreur : réponses courtes, faible latence.
  quick_action: { effort: 'low', maxTokens: 8_000, expectedOutputTokens: 1_500 },
  // Figures TikZ/pgfplots compilées puis corrigées : l'exactitude passe avant le coût.
  figure: { effort: 'high', maxTokens: 32_000, expectedOutputTokens: 6_000 },
  // Nettoyage après pandoc : transformation mécanique de textes longs.
  markdown_cleanup: { effort: 'low', maxTokens: 64_000, expectedOutputTokens: 8_000 },
}
