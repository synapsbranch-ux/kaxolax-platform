import { StatsScreen, STATS_PERIODS } from '@/components/stats/stats-screen'
import { param } from '@/lib/search-params'

export default async function StatsPage({ searchParams }: PageProps<'/stats'>) {
  const requested = Number.parseInt(param((await searchParams).days), 10)
  const days = STATS_PERIODS.find((period) => period === requested) ?? 30
  return <StatsScreen key={String(days)} days={days} />
}
