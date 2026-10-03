'use client'

import { useAuth } from '@clerk/nextjs'
import { type MePlanResponse, PLAN_FEATURES, type PlanFeature, PRO_PLAN } from '@kaxolax/contracts'
import { Alert, Badge, Button, cn, Skeleton } from '@kaxolax/ui'
import { CheckIcon, CreditCardIcon, MinusIcon, SparklesIcon } from 'lucide-react'
import Link from 'next/link'
import { useEffect, useState } from 'react'
import { api, errorMessage } from '@/lib/api'
import { planLabel } from '@/lib/plan-limits'
import {
  BILLING_URL,
  PLAN_FEATURE_LABELS,
  type PlanUsageRow,
  planUsageView,
  sessionPlan,
  USER_PRO_PLAN,
  userFeature,
} from '@/lib/plan-usage'

/** Lignes d'usage (libellé, valeur, jauge éventuelle), compte ou équipe. */
export function UsageRows({ rows }: { rows: readonly PlanUsageRow[] }) {
  return (
    <dl className="grid gap-3">
      {rows.map((row) => (
        <div key={row.label} className="grid gap-1 sm:grid-cols-[11rem_minmax(0,1fr)]">
          <dt className="font-medium">{row.label}</dt>
          <dd className="flex min-w-0 flex-col gap-1.5">
            <span>{row.value}</span>
            {row.ratio === undefined ? null : (
              <span
                role="meter"
                aria-label={`${row.label} utilisé`}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={Math.round(row.ratio * 100)}
                className="h-2 w-full overflow-hidden rounded-full bg-muted"
              >
                <span
                  className={cn(
                    'block h-full rounded-full',
                    row.ratio >= 1
                      ? 'bg-destructive'
                      : row.ratio >= 0.8
                        ? 'bg-warning'
                        : 'bg-primary',
                  )}
                  style={{ width: `${String(Math.round(row.ratio * 100))}%` }}
                />
              </span>
            )}
          </dd>
        </div>
      ))}
    </dl>
  )
}

/** Usage en cours de chargement. */
export function UsageSkeleton() {
  return (
    <div className="flex flex-col gap-2" aria-busy>
      <Skeleton className="h-4 w-2/3" />
      <Skeleton className="h-2 w-full" />
      <Skeleton className="h-4 w-1/2" />
    </div>
  )
}

/**
 * Plan et usage du compte (présentation) : plan, stockage utilisé avec sa jauge, limites,
 * features et état de l'abonnement, avec les liens vers les tarifs et la facturation. `plan` :
 * réponse de `GET /me/plan` (null pendant le chargement) ; `sessionPlanSlug` et `hasFeature`
 * viennent de la session Clerk (`has`), pour l'affichage seulement.
 */
export function PlanUsageCard({
  plan,
  error,
  sessionPlanSlug,
  hasFeature,
  className,
}: {
  plan: MePlanResponse | null
  error: string | null
  sessionPlanSlug: string
  hasFeature: (feature: PlanFeature) => boolean
  className?: string
}) {
  const view = plan === null ? null : planUsageView(plan)
  const isPro = (plan?.plan ?? sessionPlanSlug) === PRO_PLAN
  return (
    <section
      className={cn('flex flex-col gap-4 text-sm', className)}
      aria-label="Plan et usage"
      data-testid="plan-usage"
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-muted-foreground">Plan actuel</span>
        <Badge variant={isPro ? 'default' : 'secondary'} data-testid="plan-usage-plan">
          {view?.plan ?? planLabel(sessionPlanSlug)}
        </Badge>
        {view?.subscription ? (
          <span className="text-muted-foreground">{view.subscription}</span>
        ) : null}
      </div>

      {error !== null ? (
        <Alert variant="destructive">Plan et usage indisponibles : {error}</Alert>
      ) : view === null ? (
        <UsageSkeleton />
      ) : (
        <UsageRows rows={view.rows} />
      )}
      {view?.storageFull === true ? (
        <Alert variant="warning">
          Stockage plein : libérez de la place ou passez à un plan supérieur pour ajouter du
          contenu.
        </Alert>
      ) : null}

      <ul className="grid gap-1 sm:grid-cols-2" aria-label="Fonctionnalités du plan">
        {PLAN_FEATURES.map((feature) => {
          const included = hasFeature(feature)
          const Icon = included ? CheckIcon : MinusIcon
          return (
            <li
              key={feature}
              className={cn('flex items-center gap-2', !included && 'text-muted-foreground')}
              data-included={included}
            >
              <Icon className="size-4 shrink-0" aria-hidden />
              {PLAN_FEATURE_LABELS[feature]}
              <span className="sr-only">{included ? ' : incluse' : ' : non incluse'}</span>
            </li>
          )
        })}
      </ul>

      <div className="flex flex-wrap gap-2">
        <Button asChild size="sm" variant={isPro ? 'outline' : 'default'}>
          <Link href={plan?.upgradeUrl ?? '/pricing'}>
            <SparklesIcon />
            {isPro ? 'Voir les plans' : 'Passer à Pro'}
          </Link>
        </Button>
        <Button asChild size="sm" variant="outline">
          <Link href={BILLING_URL}>
            <CreditCardIcon />
            Facturation
          </Link>
        </Button>
      </div>
    </section>
  )
}

/**
 * Plan et usage du compte connecté (`GET /me/plan`), dans /account/plan et les paramètres. Le plan
 * de la session (`has` de Clerk) s'affiche tout de suite ; les limites appliquées sont celles de
 * l'API, qui les fait respecter.
 */
export function PlanUsage({ className }: { className?: string }) {
  const { has } = useAuth()
  const [plan, setPlan] = useState<MePlanResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let active = true
    api.plan().then(
      (response) => {
        if (active) setPlan(response)
      },
      (caught: unknown) => {
        if (active) setError(errorMessage(caught))
      },
    )
    return () => {
      active = false
    }
  }, [])
  return (
    <PlanUsageCard
      plan={plan}
      error={error}
      sessionPlanSlug={sessionPlan(has({ plan: USER_PRO_PLAN }))}
      hasFeature={(feature) =>
        plan !== null ? plan.features.includes(feature) : has({ feature: userFeature(feature) })
      }
      className={className}
    />
  )
}
