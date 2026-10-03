'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { SearchForm } from '@/components/search-form'
import { DataTable, EmptyRow, ErrorAlert, PageHeader, Pager } from '@/components/ui'
import { useApiData } from '@/components/use-api-data'
import { adminApi } from '@/lib/api'
import { formatBytes, formatDateTime } from '@/lib/format'
import { organizationPlanText, seatsSummary } from '@/lib/organizations'
import { hrefWith } from '@/lib/search-params'

/**
 * Liste des organisations Clerk (workspaces d'équipe) : recherche par nom, slug ou id Clerk ;
 * plan d'organisation, sièges, projets, stockage mutualisé, responsable. Lecture seule : les
 * équipes se gèrent dans le Dashboard Clerk.
 */
export function OrganizationsScreen({ q, page }: { q: string; page: number }) {
  const router = useRouter()
  const { data, error, loading } = useApiData(
    () => adminApi.organizations(q, page),
    `${q}|${String(page)}`,
  )
  const organizations = data?.organizations ?? []

  return (
    <>
      <PageHeader
        title="Organisations"
        description="Workspaces d’équipe (miroir des Organisations Clerk) et leur plan."
      >
        <SearchForm
          initial={q}
          placeholder="Nom, slug ou id org_…"
          onSearch={(value) => {
            router.push(hrefWith('/organizations', { q: value }))
          }}
        />
      </PageHeader>
      <ErrorAlert message={error} />
      <DataTable
        head={['Nom', 'Plan', 'Membres', 'Projets', 'Stockage', 'Responsable', 'Création']}
      >
        {organizations.length === 0 ? (
          <EmptyRow colSpan={7} loading={loading} />
        ) : (
          organizations.map((organization) => (
            <tr key={organization.clerkOrganizationId} className="hover:bg-accent/40">
              <td className="px-3 py-2">
                <Link
                  href={`/organizations/${encodeURIComponent(organization.clerkOrganizationId)}`}
                  className="font-medium hover:underline"
                >
                  {organization.name}
                </Link>
                {organization.deletedAt !== null ? (
                  <span className="ml-2 text-xs text-destructive">supprimée</span>
                ) : null}
                <div className="text-xs text-muted-foreground">
                  {organization.slug ?? organization.clerkOrganizationId}
                </div>
              </td>
              <td className="px-3 py-2">{organizationPlanText(organization)}</td>
              <td className="px-3 py-2">{seatsSummary(organization)}</td>
              <td className="px-3 py-2">{organization.projectCount}</td>
              <td className="px-3 py-2 text-muted-foreground">
                {formatBytes(organization.storageBytes)}
              </td>
              <td className="px-3 py-2">
                {organization.owner ? (
                  <Link href={`/users/${organization.owner.id}`} className="hover:underline">
                    {organization.owner.email}
                  </Link>
                ) : (
                  '—'
                )}
              </td>
              <td className="px-3 py-2 text-muted-foreground">
                {formatDateTime(organization.createdAt)}
              </td>
            </tr>
          ))
        )}
      </DataTable>
      <Pager
        pagination={data?.pagination}
        onPage={(next) => {
          router.push(hrefWith('/organizations', { q, page: next }))
        }}
      />
    </>
  )
}
