'use client'

import {
  ADMIN_AUDIT_ACTIONS,
  ADMIN_AUDIT_TARGET_TYPES,
  type AdminAuditAction,
  type AdminAuditEntry,
  type AdminAuditOutcome,
  type AdminAuditTargetType,
} from '@kaxolax/contracts'
import { Badge, Button, Input, Label, NativeSelect } from '@kaxolax/ui'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useId, useState } from 'react'
import { DataTable, EmptyRow, ErrorAlert, PageHeader, Pager } from '@/components/ui'
import { useApiData } from '@/components/use-api-data'
import { adminApi, type AuditLogFilters } from '@/lib/api'
import { formatDateTime } from '@/lib/format'
import { hrefWith } from '@/lib/search-params'

const ACTION_LABELS: Record<AdminAuditAction, string> = {
  'user.ban': 'Bannissement',
  'user.unban': 'Débannissement',
  'user.revoke_sessions': 'Révocation des sessions',
  'user.realtime_disconnect': 'Déconnexion temps réel',
  'user.delete': 'Suppression de compte',
  'project.transfer': 'Transfert de propriété',
  'project.archive': 'Archivage',
  'project.unarchive': 'Désarchivage',
  'project.trash': 'Mise à la corbeille',
  'project.restore': 'Restauration',
  'project.delete': 'Suppression de projet',
  'banner.create': 'Bannière créée',
  'banner.update': 'Bannière modifiée',
  'banner.delete': 'Bannière supprimée',
}

const TARGET_LABELS: Record<AdminAuditTargetType, string> = {
  user: 'Utilisateur',
  project: 'Projet',
  banner: 'Bannière',
}

/** Filtres de la page (dans l'URL) ; les jours sont en heure locale du navigateur. */
export interface AuditLogQuery {
  action: AdminAuditAction | undefined
  targetType: AdminAuditTargetType | undefined
  targetId: string | undefined
  adminId: string | undefined
  outcome: AdminAuditOutcome | undefined
  fromDay: string | undefined
  toDay: string | undefined
}

/** Jour local (`2026-10-01`) vers l'instant de début (ou de fin) de ce jour, en ISO. */
function dayBound(day: string | undefined, end: boolean): string | undefined {
  if (day === undefined) return undefined
  const date = new Date(`${day}T00:00:00`)
  if (Number.isNaN(date.getTime())) return undefined
  if (end) date.setDate(date.getDate() + 1)
  return date.toISOString()
}

function apiFilters(query: AuditLogQuery): AuditLogFilters {
  return {
    action: query.action,
    targetType: query.targetType,
    targetId: query.targetId,
    adminId: query.adminId,
    outcome: query.outcome,
    from: dayBound(query.fromDay, false),
    to: dayBound(query.toDay, true),
  }
}

function targetHref(entry: AdminAuditEntry): string | null {
  if (entry.targetId === null) return null
  if (entry.targetType === 'user') return `/users/${entry.targetId}`
  if (entry.targetType === 'project') return `/projects/${entry.targetId}`
  return null
}

/** Journal des actions de l'admin, filtrable, plus récentes d'abord. */
export function AuditLogScreen({ filters, page }: { filters: AuditLogQuery; page: number }) {
  const router = useRouter()
  const id = useId()
  const [draft, setDraft] = useState(filters)
  const { data, error, loading } = useApiData(
    () => adminApi.auditLog(apiFilters(filters), page),
    JSON.stringify({ filters, page }),
  )
  const entries = data?.entries ?? []

  function go(next: AuditLogQuery, nextPage = 1) {
    router.push(
      hrefWith('/audit-log', {
        ...next,
        from: next.fromDay,
        to: next.toDay,
        fromDay: undefined,
        toDay: undefined,
        page: nextPage,
      }),
    )
  }

  return (
    <>
      <PageHeader
        title="Journal"
        description="Chaque action de l'admin : auteur, action, cible, date."
      />
      <form
        className="mb-4 grid gap-3 rounded-lg border bg-card p-4 sm:grid-cols-2 lg:grid-cols-4"
        onSubmit={(event) => {
          event.preventDefault()
          go(draft)
        }}
      >
        <div className="grid gap-1">
          <Label htmlFor={`${id}-action`}>Action</Label>
          <NativeSelect
            id={`${id}-action`}
            className="h-9"
            value={draft.action ?? ''}
            onChange={(event) => {
              const value = event.target.value
              setDraft({ ...draft, action: ADMIN_AUDIT_ACTIONS.find((action) => action === value) })
            }}
          >
            <option value="">Toutes</option>
            {ADMIN_AUDIT_ACTIONS.map((action) => (
              <option key={action} value={action}>
                {ACTION_LABELS[action]}
              </option>
            ))}
          </NativeSelect>
        </div>
        <div className="grid gap-1">
          <Label htmlFor={`${id}-target-type`}>Type de cible</Label>
          <NativeSelect
            id={`${id}-target-type`}
            className="h-9"
            value={draft.targetType ?? ''}
            onChange={(event) => {
              const value = event.target.value
              setDraft({
                ...draft,
                targetType: ADMIN_AUDIT_TARGET_TYPES.find((type) => type === value),
              })
            }}
          >
            <option value="">Tous</option>
            {ADMIN_AUDIT_TARGET_TYPES.map((type) => (
              <option key={type} value={type}>
                {TARGET_LABELS[type]}
              </option>
            ))}
          </NativeSelect>
        </div>
        <div className="grid gap-1">
          <Label htmlFor={`${id}-target-id`}>Id de la cible</Label>
          <Input
            id={`${id}-target-id`}
            value={draft.targetId ?? ''}
            onChange={(event) => {
              const value = event.target.value.trim()
              setDraft({ ...draft, targetId: value === '' ? undefined : value })
            }}
          />
        </div>
        <div className="grid gap-1">
          <Label htmlFor={`${id}-outcome`}>Résultat</Label>
          <NativeSelect
            id={`${id}-outcome`}
            className="h-9"
            value={draft.outcome ?? ''}
            onChange={(event) => {
              const value = event.target.value
              setDraft({
                ...draft,
                outcome: value === 'success' || value === 'failure' ? value : undefined,
              })
            }}
          >
            <option value="">Tous</option>
            <option value="success">Réussite</option>
            <option value="failure">Échec</option>
          </NativeSelect>
        </div>
        <div className="grid gap-1">
          <Label htmlFor={`${id}-from`}>Du</Label>
          <Input
            id={`${id}-from`}
            type="date"
            value={draft.fromDay ?? ''}
            onChange={(event) => {
              setDraft({ ...draft, fromDay: event.target.value || undefined })
            }}
          />
        </div>
        <div className="grid gap-1">
          <Label htmlFor={`${id}-to`}>Au</Label>
          <Input
            id={`${id}-to`}
            type="date"
            value={draft.toDay ?? ''}
            onChange={(event) => {
              setDraft({ ...draft, toDay: event.target.value || undefined })
            }}
          />
        </div>
        <div className="flex items-end gap-2 lg:col-span-2">
          <Button type="submit">Filtrer</Button>
          <Button
            type="button"
            variant="outline"
            onClick={() => {
              router.push('/audit-log')
            }}
          >
            Réinitialiser
          </Button>
          {filters.adminId !== undefined ? (
            <span className="text-xs text-muted-foreground">Filtré sur un auteur.</span>
          ) : null}
        </div>
      </form>
      <ErrorAlert message={error} />
      <DataTable head={['Date', 'Auteur', 'Action', 'Cible', 'Résultat', 'Détails']}>
        {entries.length === 0 ? (
          <EmptyRow colSpan={6} loading={loading} />
        ) : (
          entries.map((entry) => {
            const href = targetHref(entry)
            return (
              <tr key={entry.id} className="align-top">
                <td className="px-3 py-2 whitespace-nowrap text-muted-foreground">
                  {formatDateTime(entry.createdAt)}
                </td>
                <td className="px-3 py-2">
                  <Link
                    href={hrefWith('/audit-log', { adminId: entry.admin.id })}
                    className="hover:underline"
                  >
                    {entry.admin.email}
                  </Link>
                </td>
                <td className="px-3 py-2">{ACTION_LABELS[entry.action]}</td>
                <td className="px-3 py-2">
                  <span className="text-muted-foreground">{TARGET_LABELS[entry.targetType]} </span>
                  {entry.targetId === null ? (
                    '—'
                  ) : href === null ? (
                    <span className="font-mono text-xs">{entry.targetId}</span>
                  ) : (
                    <Link href={href} className="font-mono text-xs hover:underline">
                      {entry.targetId}
                    </Link>
                  )}
                </td>
                <td className="px-3 py-2">
                  <Badge variant={entry.outcome === 'success' ? 'outline' : 'destructive'}>
                    {entry.outcome === 'success' ? 'Réussite' : 'Échec'}
                  </Badge>
                </td>
                <td className="px-3 py-2">
                  {Object.keys(entry.metadata).length === 0 ? (
                    '—'
                  ) : (
                    <details>
                      <summary className="cursor-pointer text-muted-foreground">Voir</summary>
                      <pre className="mt-1 max-w-sm overflow-x-auto rounded bg-muted p-2 text-xs">
                        {JSON.stringify(entry.metadata, null, 2)}
                      </pre>
                    </details>
                  )}
                </td>
              </tr>
            )
          })
        )}
      </DataTable>
      <Pager
        pagination={data?.pagination}
        onPage={(next) => {
          go(filters, next)
        }}
      />
    </>
  )
}
