import type Anthropic from '@anthropic-ai/sdk'

/**
 * Prix de l'API Anthropic par modèle : seule table de prix de l'API Kaxolax. Valeurs en dollars
 * par million de tokens, c'est-à-dire en micro-dollars par token. Écriture en cache : 1,25 × le
 * prix d'entrée (durée de vie 5 min) ou 2 × (1 h). Lecture du cache : prix propre à chaque modèle,
 * sans règle commune (0,20 $ pour Opus 5.5, soit 0,05 × son entrée ; 0,1 × pour Opus 5 et 4.8) :
 * reprendre la grille officielle, ne pas la recalculer.
 *
 * Le modèle par défaut est `claude-opus-5-5` ; Claude Opus 5 et Claude Opus 4.8 sont les cibles
 * possibles du repli serveur (`fallbacks: "default"`), facturées à leur propre prix.
 */
export interface ModelPricing {
  readonly input: number
  readonly output: number
  readonly cacheRead: number
  readonly cacheWrite5m: number
  readonly cacheWrite1h: number
}

export const MODEL_PRICING: Readonly<Record<string, ModelPricing>> = {
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2, cacheWrite5m: 5, cacheWrite1h: 8 },
  'claude-opus-5': { input: 5, output: 25, cacheRead: 0.5, cacheWrite5m: 6.25, cacheWrite1h: 10 },
  'claude-opus-4-8': { input: 5, output: 25, cacheRead: 0.5, cacheWrite5m: 6.25, cacheWrite1h: 10 },
}

/** Prix le plus élevé de chaque ligne de la table : modèle demandé ou toute cible du repli serveur. */
export function highestPricing(): ModelPricing {
  const all = Object.values(MODEL_PRICING)
  const highest = (key: keyof ModelPricing) => Math.max(...all.map((entry) => entry[key]))
  return {
    input: highest('input'),
    output: highest('output'),
    cacheRead: highest('cacheRead'),
    cacheWrite5m: highest('cacheWrite5m'),
    cacheWrite1h: highest('cacheWrite1h'),
  }
}

/**
 * Prix d'un modèle absent de la table (nouveau modèle de repli) : le plus élevé de chaque ligne,
 * pour ne jamais sous-compter ; `known` faux pour le signaler dans le journal.
 */
export function pricingOf(model: string): { pricing: ModelPricing; known: boolean } {
  const pricing = MODEL_PRICING[model]
  if (pricing) return { pricing, known: true }
  return { pricing: highestPricing(), known: false }
}

/** Tokens d'un appel (ou d'une itération), cache compris. */
export interface TokenUsage {
  inputTokens: number
  outputTokens: number
  cacheReadInputTokens: number
  /** Total écrit en cache (5 min et 1 h). */
  cacheCreationInputTokens: number
  /** Part écrite avec une durée de vie d'une heure. */
  cacheCreation1hInputTokens: number
}

/** Tokens facturés à un modèle. */
export interface UsageLine extends TokenUsage {
  model: string
}

interface RawUsage {
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens: number | null
  cache_creation_input_tokens: number | null
  cache_creation: Anthropic.Beta.BetaCacheCreation | null
}

function tokensOf(usage: RawUsage): TokenUsage {
  const cacheCreation = usage.cache_creation_input_tokens ?? 0
  return {
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    cacheReadInputTokens: usage.cache_read_input_tokens ?? 0,
    cacheCreationInputTokens: cacheCreation,
    cacheCreation1hInputTokens: Math.min(
      cacheCreation,
      usage.cache_creation?.ephemeral_1h_input_tokens ?? 0,
    ),
  }
}

/**
 * Lignes facturées d'une réponse. `usage.iterations`, quand l'API le renvoie, est la source de
 * vérité par tentative (repli serveur : modèle refusé puis modèle de repli ; compaction ; outils
 * serveur) : chaque entrée est comptée au prix de son modèle. Sinon, l'usage global au prix du
 * modèle de la réponse. Une tentative refusée avant toute sortie est comptée aussi (estimation
 * prudente).
 */
export function usageLines(
  message: Pick<Anthropic.Beta.BetaMessage, 'model' | 'usage'>,
): UsageLine[] {
  const iterations = message.usage.iterations ?? []
  if (iterations.length === 0) return [{ model: message.model, ...tokensOf(message.usage) }]
  return iterations.map((iteration) => ({
    model: 'model' in iteration && iteration.model ? iteration.model : message.model,
    ...tokensOf(iteration),
  }))
}

/** Coût d'une ligne en micro-dollars (fractionnaire). */
export function lineCostMicros(line: UsageLine): number {
  const { pricing } = pricingOf(line.model)
  const cache1h = line.cacheCreation1hInputTokens
  const cache5m = line.cacheCreationInputTokens - cache1h
  return (
    line.inputTokens * pricing.input +
    line.outputTokens * pricing.output +
    line.cacheReadInputTokens * pricing.cacheRead +
    cache5m * pricing.cacheWrite5m +
    cache1h * pricing.cacheWrite1h
  )
}

/** Coût et tokens d'un appel : total des lignes, coût arrondi au micro-dollar supérieur. */
export interface CallCost {
  lines: UsageLine[]
  totals: TokenUsage
  costMicros: number
  /** Modèles de la réponse absents de la table des prix. */
  unknownModels: string[]
}

export function callCost(message: Pick<Anthropic.Beta.BetaMessage, 'model' | 'usage'>): CallCost {
  const lines = usageLines(message)
  const totals: TokenUsage = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    cacheCreation1hInputTokens: 0,
  }
  let cost = 0
  for (const line of lines) {
    totals.inputTokens += line.inputTokens
    totals.outputTokens += line.outputTokens
    totals.cacheReadInputTokens += line.cacheReadInputTokens
    totals.cacheCreationInputTokens += line.cacheCreationInputTokens
    totals.cacheCreation1hInputTokens += line.cacheCreation1hInputTokens
    cost += lineCostMicros(line)
  }
  const unknownModels = [
    ...new Set(lines.map((line) => line.model).filter((model) => !pricingOf(model).known)),
  ]
  return { lines, totals, costMicros: Math.ceil(cost), unknownModels }
}

/** Tokens d'entrée estimés : un token pour 3 caractères du JSON envoyé (prudent en français et LaTeX). */
export function estimateInputTokens(request: {
  system?: unknown
  tools?: unknown
  messages: unknown
}): number {
  const characters = JSON.stringify([request.system, request.tools, request.messages]).length
  return Math.ceil(characters / 3)
}

/**
 * Estimation du coût attendu d'un appel, au prix du modèle demandé : entrée estimée
 * (`estimateInputTokens`) et sortie attendue. Plancher facturé d'une réponse interrompue.
 */
export function estimateCostMicros(
  model: string,
  request: { system?: unknown; tools?: unknown; messages: unknown },
  expectedOutputTokens: number,
): number {
  const { pricing } = pricingOf(model)
  const inputTokens = estimateInputTokens(request)
  return Math.max(1, Math.ceil(inputTokens * pricing.input + expectedOutputTokens * pricing.output))
}

/**
 * Coût maximal d'un appel (réservation des crédits) : entrée estimée et `maxOutputTokens` en
 * entier, aux prix les plus élevés de la table (le repli serveur peut servir un modèle plus cher).
 * Seule l'erreur d'estimation de l'entrée (écritures en cache, entrée relue par le repli) peut
 * faire dépasser ce montant au coût réel.
 */
export function worstCaseCostMicros(
  request: { system?: unknown; tools?: unknown; messages: unknown },
  maxOutputTokens: number,
): number {
  const pricing = highestPricing()
  const inputTokens = estimateInputTokens(request)
  return Math.max(1, Math.ceil(inputTokens * pricing.input + maxOutputTokens * pricing.output))
}

/**
 * Plus grand `max_tokens` dont le coût maximal (`worstCaseCostMicros`) tient dans `budgetMicros`,
 * borné à `maxOutputTokens` (0 si l'entrée seule dépasse le budget).
 */
export function outputTokensWithin(
  request: { system?: unknown; tools?: unknown; messages: unknown },
  budgetMicros: number,
  maxOutputTokens: number,
): number {
  const pricing = highestPricing()
  const left = budgetMicros - estimateInputTokens(request) * pricing.input
  return Math.max(0, Math.min(maxOutputTokens, Math.floor(left / pricing.output)))
}

/**
 * Tokens de sortie visibles d'une réponse interrompue, estimés à un token pour 3 caractères du
 * contenu reçu (texte, réflexion, entrées d'outils) : l'usage du flux ne donne la sortie qu'à la
 * fin (`message_delta`).
 */
export function visibleOutputTokens(content: readonly Anthropic.Beta.BetaContentBlock[]): number {
  let characters = 0
  for (const block of content) {
    if (block.type === 'text') characters += block.text.length
    else if (block.type === 'thinking') characters += block.thinking.length
    else if (block.type === 'tool_use') characters += JSON.stringify(block.input).length
  }
  return Math.ceil(characters / 3)
}
