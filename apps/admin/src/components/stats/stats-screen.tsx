'use client'

import { type CompileStatus, compileStatusSchema } from '@kaxolax/contracts'
import { Card, CardContent, CardHeader, CardTitle, cn } from '@kaxolax/ui'
import Link from 'next/link'
import { useMemo, type ReactNode } from 'react'
import { DailyBars, HorizontalBars } from '@/components/stats/charts'
import { DataTable, ErrorAlert, PageHeader } from '@/components/ui'
import { useApiData } from '@/components/use-api-data'
import { adminApi } from '@/lib/api'
import { formatDuration, formatNumber, formatRate } from '@/lib/format'

/** Périodes proposées, en jours. */
export const STATS_PERIODS = [7, 30, 90, 365] as const

const STATUS_LABELS: Record<CompileStatus, string> = {
  success: 'Réussies',
  failure: 'Erreurs LaTeX',
  timeout: 'Durée dépassée',
  error: 'Erreur du service',
}

const DAY_MS = 86_400_000

function StatCard({ label, value, hint }: { label: string; value: string; hint?: ReactNode }) {
  return (
    <Card className="gap-1 py-4">
      <CardContent className="px-4">
        <p className="text-sm text-muted-foreground">{label}</p>
        <p className="mt-1 text-2xl font-semibold tabular-nums">{value}</p>
        {hint !== undefined ? <p className="mt-1 text-xs text-muted-foreground">{hint}</p> : null}
      </CardContent>
    </Card>
  )
}

/** Statistiques : inscriptions, actifs, abonnés Pro, compilations (volume, durée, échecs, agents). */
export function StatsScreen({ days }: { days: number }) {
  // Période figée au montage (la clé de la page change avec `days`).
  const period = useMemo(() => {
    const to = new Date()
    return { from: new Date(to.getTime() - days * DAY_MS).toISOString(), to: to.toISOString() }
  }, [days])
  const {
    data: stats,
    error,
    loading,
  } = useApiData(() => adminApi.stats(period.from, period.to), `${period.from}|${period.to}`)

  return (
    <>
      <PageHeader
        title="Statistiques"
        description="Inscriptions, activité, abonnements et compilations."
      >
        <nav className="flex gap-1 rounded-md border p-1" aria-label="Période">
          {STATS_PERIODS.map((value) => (
            <Link
              key={value}
              href={value === 30 ? '/stats' : `/stats?days=${String(value)}`}
              aria-current={value === days ? 'page' : undefined}
              className={cn(
                'rounded px-3 py-1 text-sm text-muted-foreground hover:bg-accent',
                value === days && 'bg-accent text-accent-foreground',
              )}
            >
              {value} j
            </Link>
          ))}
        </nav>
      </PageHeader>
      <ErrorAlert message={error} />
      {stats === null ? (
        loading ? (
          <p className="text-sm text-muted-foreground">Chargement…</p>
        ) : null
      ) : (
        <div className="grid gap-4">
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
            <StatCard
              label={`Inscriptions (${String(days)} j)`}
              value={formatNumber(stats.signups.total)}
            />
            <StatCard
              label="Utilisateurs actifs (7 j)"
              value={formatNumber(stats.activeUsers.last7Days)}
              hint={`${formatNumber(stats.activeUsers.last30Days)} sur 30 jours`}
            />
            <StatCard
              label="Abonnés Pro"
              value={formatNumber(stats.subscriptions.pro)}
              hint="Abonnements actifs"
            />
            <StatCard
              label={`Compilations (${String(days)} j)`}
              value={formatNumber(stats.compiles.total)}
              hint={`Durée moyenne ${formatDuration(stats.compiles.averageDurationMs)} · échecs ${formatRate(stats.compiles.failureRate)}`}
            />
          </div>

          <Card>
            <CardHeader>
              <CardTitle>Inscriptions par jour</CardTitle>
            </CardHeader>
            <CardContent>
              <DailyBars points={stats.signups.byDay} unit={['inscription', 'inscriptions']} />
            </CardContent>
          </Card>

          <div className="grid gap-4 lg:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle>Compilations par résultat</CardTitle>
              </CardHeader>
              <CardContent>
                <HorizontalBars
                  rows={compileStatusSchema.options.map((status) => {
                    const value = stats.compiles.byStatus[status]
                    return {
                      label: STATUS_LABELS[status],
                      value,
                      display: `${formatNumber(value)} · ${formatRate(stats.compiles.total === 0 ? null : value / stats.compiles.total)}`,
                    }
                  })}
                />
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle>Abonnements par plan</CardTitle>
              </CardHeader>
              <CardContent>
                {stats.subscriptions.byPlan.length === 0 ? (
                  <p className="text-sm text-muted-foreground">Aucun abonnement.</p>
                ) : (
                  <DataTable head={['Plan', 'Actifs', 'Paiement en retard']}>
                    {stats.subscriptions.byPlan.map((plan) => (
                      <tr key={plan.planSlug}>
                        <td className="px-3 py-2">{plan.planSlug}</td>
                        <td className="px-3 py-2 tabular-nums">{formatNumber(plan.active)}</td>
                        <td className="px-3 py-2 tabular-nums">{formatNumber(plan.pastDue)}</td>
                      </tr>
                    ))}
                  </DataTable>
                )}
              </CardContent>
            </Card>
          </div>

          <Card>
            <CardHeader>
              <CardTitle>Compilations par agent</CardTitle>
            </CardHeader>
            <CardContent>
              <DataTable head={['Agent', 'Compilations', 'Durée moyenne', "Taux d'échec"]}>
                {stats.compiles.byAgent.length === 0 ? (
                  <tr>
                    <td colSpan={4} className="px-3 py-6 text-center text-muted-foreground">
                      Aucune compilation sur la période.
                    </td>
                  </tr>
                ) : (
                  stats.compiles.byAgent.map((agent) => (
                    <tr key={agent.agentId ?? 'none'}>
                      <td className="px-3 py-2 font-mono text-xs">
                        {agent.agentId ?? 'sans agent'}
                      </td>
                      <td className="px-3 py-2 tabular-nums">{formatNumber(agent.total)}</td>
                      <td className="px-3 py-2 tabular-nums">
                        {formatDuration(agent.averageDurationMs)}
                      </td>
                      <td className="px-3 py-2">
                        <span className="flex items-center gap-2">
                          <span
                            className="h-2 w-24 overflow-hidden rounded-sm bg-muted"
                            aria-hidden
                          >
                            <span
                              className="block h-full bg-chart-2"
                              style={{ width: `${String((agent.failureRate ?? 0) * 100)}%` }}
                            />
                          </span>
                          <span className="tabular-nums">{formatRate(agent.failureRate)}</span>
                        </span>
                      </td>
                    </tr>
                  ))
                )}
              </DataTable>
            </CardContent>
          </Card>
        </div>
      )}
    </>
  )
}
