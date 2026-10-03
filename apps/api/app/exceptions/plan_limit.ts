import { PLAN_LIMIT_FEATURES, type PlanLimitError, type PlanLimitName } from '@kaxolax/contracts'
import { Exception } from '@adonisjs/core/exceptions'
import type { HttpContext } from '@adonisjs/core/http'
import { appUrl } from '#config/app'

/** Page de tarifs de l'application (bouton des refus `E_PLAN_LIMIT`). */
export function pricingUrl(): string {
  return `${appUrl.replace(/\/$/, '')}/pricing`
}

const MESSAGES: Record<PlanLimitName, string> = {
  compile_time: 'The compile time limit of the project owner plan is reached',
  collaborators: 'The collaborator limit of the project owner plan is reached',
  storage: 'The storage limit of the project owner plan is reached',
  history: 'The history retention of the project owner plan is reached',
  ai_credits: 'The monthly AI credits of your plan are used up',
  image_credits: 'The monthly image credits of your plan are used up',
}

export interface PlanLimitDetails {
  name: PlanLimitName
  /** Slug du plan Clerk dont la limite s'applique. */
  plan: string
  max: number
  /** Usage au moment du refus, si connu. */
  current?: number
}

/** Corps homogène d'un refus (et d'un résultat de compilation en délai dépassé). */
export function planLimitBody(details: PlanLimitDetails): PlanLimitError {
  return {
    code: 'E_PLAN_LIMIT',
    message: MESSAGES[details.name],
    limit: { name: details.name, plan: details.plan, max: details.max },
    feature: PLAN_LIMIT_FEATURES[details.name],
    ...(details.current === undefined ? {} : { current: details.current }),
    upgradeUrl: pricingUrl(),
  }
}

/**
 * Limite du plan atteinte (403 `E_PLAN_LIMIT`) : même corps pour toutes les limites, rendu par
 * l'exception elle-même (identique en développement et en production).
 */
export class PlanLimitException extends Exception {
  static override status = 403
  static override code = 'E_PLAN_LIMIT'

  constructor(readonly details: PlanLimitDetails) {
    super(MESSAGES[details.name])
  }

  handle(_error: unknown, { response }: HttpContext) {
    response.status(403).send(planLimitBody(this.details))
  }
}
