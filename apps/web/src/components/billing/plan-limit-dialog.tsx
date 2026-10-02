'use client'

import type { PlanLimitError } from '@kaxolax/contracts'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@kaxolax/ui'
import { useEffect, useState } from 'react'
import { onPlanLimit, planLimitMessage } from '@/lib/plan-limits'
import { PlanLimitNotice } from './plan-limit-notice'

/**
 * Boîte de dialogue des limites du plan, montée une fois pour toutes les pages de l'application :
 * tout refus `E_PLAN_LIMIT` reçu par le client de l'API (upload, création de fichier, import,
 * invitation) s'y explique, sauf si l'écran l'affiche lui-même (`markPlanLimitHandled`).
 */
export function PlanLimitDialog() {
  const [error, setError] = useState<PlanLimitError | null>(null)

  useEffect(
    () =>
      onPlanLimit((received, handled) => {
        // Après le `catch` de l'appelant, qui peut afficher le refus lui-même.
        setTimeout(() => {
          if (!handled()) setError(received)
        }, 0)
      }),
    [],
  )

  return (
    <Dialog
      open={error !== null}
      onOpenChange={(open) => {
        if (!open) setError(null)
      }}
    >
      <DialogContent data-testid="plan-limit-dialog">
        <DialogHeader>
          <DialogTitle>{error ? planLimitMessage(error).title : ''}</DialogTitle>
          <DialogDescription>Limite de votre plan Kaxolax</DialogDescription>
        </DialogHeader>
        {error ? <PlanLimitNotice error={error} compact /> : null}
      </DialogContent>
    </Dialog>
  )
}
