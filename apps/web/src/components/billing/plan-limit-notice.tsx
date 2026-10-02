import type { PlanLimitError } from '@kaxolax/contracts'
import { Alert, Button, cn } from '@kaxolax/ui'
import { SparklesIcon } from 'lucide-react'
import Link from 'next/link'
import { planLimitMessage } from '@/lib/plan-limits'

/**
 * Limite du plan atteinte (refus `E_PLAN_LIMIT` de l'API, ou compilation arrêtée à la durée du
 * plan) : message clair, valeur de la limite et bouton vers la page de tarifs. Réutilisable en
 * ligne (résultat de compilation, modale de partage) ; `ApiError.planLimit` fournit `error`.
 */
export function PlanLimitNotice({
  error,
  className,
  compact = false,
}: {
  error: PlanLimitError
  className?: string
  /** Sans titre (zones étroites, comme l'en-tête du PDF). */
  compact?: boolean
}) {
  const { title, description } = planLimitMessage(error)
  return (
    <Alert
      variant="warning"
      className={cn('flex flex-col gap-2', className)}
      data-testid="plan-limit-notice"
      data-limit={error.limit.name}
    >
      {compact ? null : <p className="font-medium">{title}</p>}
      <p className="text-muted-foreground">{description}</p>
      <Button asChild size="sm" className="self-start">
        <Link href={error.upgradeUrl}>
          <SparklesIcon />
          Voir les plans
        </Link>
      </Button>
    </Alert>
  )
}
