import { ADMIN_AUDIT_ACTIONS, ADMIN_AUDIT_TARGET_TYPES } from '@kaxolax/contracts'
import { AuditLogScreen, type AuditLogQuery } from '@/components/audit/audit-log-screen'
import { pageParam, param } from '@/lib/search-params'

const DAY = /^\d{4}-\d{2}-\d{2}$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export default async function AuditLogPage({ searchParams }: PageProps<'/audit-log'>) {
  const query = await searchParams
  const outcome = param(query.outcome)
  const from = param(query.from)
  const to = param(query.to)
  const adminId = param(query.adminId)
  // Paramètres inconnus ou mal formés ignorés : le filtre correspondant est simplement vide.
  const filters: AuditLogQuery = {
    action: ADMIN_AUDIT_ACTIONS.find((value) => value === param(query.action)),
    targetType: ADMIN_AUDIT_TARGET_TYPES.find((value) => value === param(query.targetType)),
    targetId: param(query.targetId).trim().slice(0, 255) || undefined,
    adminId: UUID.test(adminId) ? adminId : undefined,
    outcome: outcome === 'success' || outcome === 'failure' ? outcome : undefined,
    fromDay: DAY.test(from) ? from : undefined,
    toDay: DAY.test(to) ? to : undefined,
  }
  const page = pageParam(query.page)
  return <AuditLogScreen key={JSON.stringify({ filters, page })} filters={filters} page={page} />
}
