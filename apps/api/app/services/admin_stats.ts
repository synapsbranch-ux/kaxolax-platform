import {
  ADMIN_STATS_DEFAULT_DAYS,
  ADMIN_STATS_MAX_DAYS,
  type AdminStats,
  type CompileStatus,
  compileStatusSchema,
} from '@kaxolax/contracts'
import { Exception } from '@adonisjs/core/exceptions'
import db from '@adonisjs/lucid/services/db'
import { DateTime } from 'luxon'
import { isoString } from '#services/dates'

export class InvalidStatsPeriodException extends Exception {
  static override status = 422
  static override code = 'E_INVALID_STATS_PERIOD'
  static override message = `The period must start before it ends and last at most ${String(ADMIN_STATS_MAX_DAYS)} days`
}

/** Plan dont les abonnés actifs sont comptés à part. */
const PRO_PLAN_SLUG = 'pro'

/** Période [from, to) : par défaut les 30 jours qui précèdent `to` (maintenant). */
export function statsPeriod(input: { from?: DateTime | undefined; to?: DateTime | undefined }) {
  const to = input.to ?? DateTime.utc()
  const from = input.from ?? to.minus({ days: ADMIN_STATS_DEFAULT_DAYS })
  if (from >= to || to.diff(from, 'days').days > ADMIN_STATS_MAX_DAYS) {
    throw new InvalidStatsPeriodException()
  }
  return { from, to }
}

async function rows<T>(sql: string, bindings: unknown[]): Promise<T[]> {
  const result = await db.rawQuery<{ rows: T[] }>(sql, bindings)
  return result.rows
}

/** Inscriptions par jour UTC de la période (jours sans inscription compris). */
async function signupsByDay(from: Date, to: Date) {
  return rows<{ date: string; count: number }>(
    `SELECT to_char(day, 'YYYY-MM-DD') AS date, COUNT(u.id)::int AS count
     FROM generate_series(
       date_trunc('day', ?::timestamptz AT TIME ZONE 'UTC'),
       date_trunc('day', (?::timestamptz - interval '1 microsecond') AT TIME ZONE 'UTC'),
       interval '1 day'
     ) AS day
     LEFT JOIN users u
       ON u.created_at >= GREATEST(day AT TIME ZONE 'UTC', ?::timestamptz)
      AND u.created_at < LEAST((day + interval '1 day') AT TIME ZONE 'UTC', ?::timestamptz)
     GROUP BY day
     ORDER BY day`,
    [from, to, from, to],
  )
}

/**
 * Comptes non supprimés actifs dans [since, until) : une compilation lancée, une version dont ils
 * sont auteurs (historique), ou un projet possédé modifié (projects.updated_at, mis à jour par
 * l'API et par chaque enregistrement du service temps réel).
 */
async function activeUsers(since: Date, until: Date): Promise<number> {
  const [row] = await rows<{ count: number }>(
    `SELECT COUNT(*)::int AS count FROM users u
     WHERE u.deleted_at IS NULL AND (
       EXISTS (SELECT 1 FROM compiles c
               WHERE c.user_id = u.id AND c.created_at >= ? AND c.created_at < ?)
       OR EXISTS (SELECT 1 FROM project_versions v
                  WHERE u.id = ANY (v.author_ids) AND v.created_at >= ? AND v.created_at < ?)
       OR EXISTS (SELECT 1 FROM projects p
                  WHERE p.owner_id = u.id AND p.updated_at >= ? AND p.updated_at < ?)
     )`,
    [since, until, since, until, since, until],
  )
  return row?.count ?? 0
}

/**
 * Abonnements à l'instant, par plan : payeurs distincts (comptes, ou organisations pour un plan
 * d'équipe) actifs ou en retard de paiement.
 */
async function subscriptionsByPlan() {
  return rows<{ plan_slug: string; active: number; past_due: number }>(
    `SELECT plan_slug,
            COUNT(DISTINCT COALESCE(user_id::text, clerk_organization_id))
              FILTER (WHERE status = 'active')::int AS active,
            COUNT(DISTINCT COALESCE(user_id::text, clerk_organization_id))
              FILTER (WHERE status = 'past_due')::int AS past_due
     FROM subscriptions
     WHERE status IN ('active', 'past_due')
     GROUP BY plan_slug
     ORDER BY plan_slug`,
    [],
  )
}

interface CompileGroup {
  agent_id: string | null
  /** Tous les statuts de `compiles`, compilations asynchrones en cours et annulées comprises. */
  status: string
  count: number
  duration_ms: string | number
}

interface CompileTotals {
  total: number
  failures: number
  durationMs: number
}

function rateOf(totals: CompileTotals) {
  return {
    averageDurationMs: totals.total === 0 ? null : totals.durationMs / totals.total,
    failureRate: totals.total === 0 ? null : totals.failures / totals.total,
  }
}

/** Statut d'une compilation annulée (mode asynchrone), compté à part. */
const CANCELLED = 'cancelled'

/**
 * Compilations de la période : volume, statuts, durée moyenne et taux d'échec, par agent. Seules
 * les compilations terminées par le compilateur comptent (mêmes statuts que `lastCompile`) : une
 * compilation encore en cours (`queued`, `preparing`, `running`) n'a ni résultat ni durée, et une
 * annulation (`cancelled`) n'est ni une réussite ni un échec du compilateur (comptée à part).
 */
async function compileStats(from: Date, to: Date): Promise<AdminStats['compiles']> {
  const groups = await rows<CompileGroup>(
    `SELECT agent_id, status, COUNT(*)::int AS count, COALESCE(SUM(duration_ms), 0) AS duration_ms
     FROM compiles WHERE created_at >= ? AND created_at < ?
     GROUP BY agent_id, status`,
    [from, to],
  )
  const byStatus: Record<CompileStatus, number> = { success: 0, failure: 0, timeout: 0, error: 0 }
  let cancelled = 0
  const overall: CompileTotals = { total: 0, failures: 0, durationMs: 0 }
  const agents = new Map<string | null, CompileTotals>()
  for (const group of groups) {
    if (group.status === CANCELLED) {
      cancelled += group.count
      continue
    }
    const status = compileStatusSchema.safeParse(group.status)
    // En cours (`queued`, `preparing`, `running`) : pas encore de résultat.
    if (!status.success) continue
    byStatus[status.data] += group.count
    let agent = agents.get(group.agent_id)
    if (!agent) {
      agent = { total: 0, failures: 0, durationMs: 0 }
      agents.set(group.agent_id, agent)
    }
    for (const totals of [overall, agent]) {
      totals.total += group.count
      totals.failures += status.data === 'success' ? 0 : group.count
      totals.durationMs += Number(group.duration_ms)
    }
  }
  return {
    total: overall.total,
    byStatus,
    cancelled,
    ...rateOf(overall),
    byAgent: [...agents.entries()]
      .map(([agentId, totals]) => ({ agentId, total: totals.total, ...rateOf(totals) }))
      .sort((a, b) => b.total - a.total || String(a.agentId).localeCompare(String(b.agentId))),
  }
}

/**
 * Statistiques de l'admin sur [from, to) : inscriptions par jour, utilisateurs actifs sur 7 et 30
 * jours (fenêtres qui se terminent à `to`), abonnés (à l'instant) et compilations.
 */
export async function adminStats(period: { from: DateTime; to: DateTime }): Promise<AdminStats> {
  const from = period.from.toJSDate()
  const to = period.to.toJSDate()
  // Requêtes à la suite : une connexion suffit pour une page consultée par quelques admins.
  const signups = await signupsByDay(from, to)
  const last7Days = await activeUsers(period.to.minus({ days: 7 }).toJSDate(), to)
  const last30Days = await activeUsers(period.to.minus({ days: 30 }).toJSDate(), to)
  const plans = await subscriptionsByPlan()
  const compiles = await compileStats(from, to)
  return {
    period: { from: isoString(period.from), to: isoString(period.to) },
    signups: {
      total: signups.reduce((sum, day) => sum + day.count, 0),
      byDay: signups,
    },
    activeUsers: { last7Days, last30Days },
    subscriptions: {
      pro: plans.find((plan) => plan.plan_slug === PRO_PLAN_SLUG)?.active ?? 0,
      byPlan: plans.map((plan) => ({
        planSlug: plan.plan_slug,
        active: plan.active,
        pastDue: plan.past_due,
      })),
    },
    compiles,
  }
}
