'use client'

import { Alert } from '@kaxolax/ui'
import { PlanLimitNotice } from '@/components/billing/plan-limit-notice'
import { ApiError } from '@/lib/api'
import { sharingErrorMessage } from '@/lib/sharing'

/**
 * Erreur d'une action du partage. Limite du plan atteinte (`E_PLAN_LIMIT`) : `PlanLimitNotice`
 * (limite et lien vers les tarifs) ; l'appelant marque l'erreur (`markPlanLimitHandled`) pour que
 * la boîte de dialogue globale ne s'ouvre pas aussi. Sinon le message de l'erreur.
 */
export function SharingError({ error, onDismiss }: { error: unknown; onDismiss?: () => void }) {
  const limit = error instanceof ApiError ? error.planLimit : null
  const dismiss = onDismiss ? (
    <button type="button" className="self-start text-xs underline" onClick={onDismiss}>
      Fermer
    </button>
  ) : null
  if (limit) {
    return (
      <div className="flex flex-col gap-2" data-testid="sharing-error">
        <PlanLimitNotice error={limit} />
        {dismiss}
      </div>
    )
  }
  return (
    <Alert variant="destructive" data-testid="sharing-error">
      <div className="flex flex-col gap-2">
        <p>{sharingErrorMessage(error)}</p>
        {dismiss}
      </div>
    </Alert>
  )
}
