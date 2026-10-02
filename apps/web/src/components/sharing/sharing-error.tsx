'use client'

import { Alert, Button } from '@kaxolax/ui'
import Link from 'next/link'
import { planLimitOf, planLimitText, PRICING_URL, sharingErrorMessage } from '@/lib/sharing'

/**
 * Erreur d'une action du partage. Limite du plan atteinte (`E_PLAN_LIMIT`) : la limite et un lien
 * vers les tarifs ; sinon le message de l'erreur.
 */
export function SharingError({ error, onDismiss }: { error: unknown; onDismiss?: () => void }) {
  const limit = planLimitOf(error)
  return (
    <Alert variant={limit ? 'warning' : 'destructive'} data-testid="sharing-error">
      <div className="flex flex-col gap-2">
        {limit ? (
          <>
            <p className="font-medium">Limite de collaborateurs atteinte</p>
            <p>{planLimitText(limit)}</p>
            <p>
              <Button asChild size="sm" variant="outline">
                <Link href={PRICING_URL} data-testid="plan-limit-pricing">
                  Voir les plans et la facturation
                </Link>
              </Button>
            </p>
          </>
        ) : (
          <p>{sharingErrorMessage(error)}</p>
        )}
        {onDismiss ? (
          <button type="button" className="self-start text-xs underline" onClick={onDismiss}>
            Fermer
          </button>
        ) : null}
      </div>
    </Alert>
  )
}
