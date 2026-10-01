'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { SearchForm } from '@/components/search-form'
import { DataTable, EmptyRow, ErrorAlert, PageHeader, Pager } from '@/components/ui'
import { useApiData } from '@/components/use-api-data'
import { UserState } from '@/components/users/user-state'
import { adminApi } from '@/lib/api'
import { formatDateTime } from '@/lib/format'
import { hrefWith } from '@/lib/search-params'

/** Liste des utilisateurs : recherche par email, nom ou id (local ou Clerk). */
export function UsersScreen({ q, page }: { q: string; page: number }) {
  const router = useRouter()
  const { data, error, loading } = useApiData(() => adminApi.users(q, page), `${q}|${String(page)}`)
  const users = data?.users ?? []

  return (
    <>
      <PageHeader title="Utilisateurs" description="Comptes Kaxolax (miroir des comptes Clerk).">
        <SearchForm
          initial={q}
          placeholder="Email, nom ou id"
          onSearch={(value) => {
            router.push(hrefWith('/users', { q: value }))
          }}
        />
      </PageHeader>
      <ErrorAlert message={error} />
      <DataTable head={['Email', 'Nom', 'Plan', 'Inscription', 'État']}>
        {users.length === 0 ? (
          <EmptyRow colSpan={5} loading={loading} />
        ) : (
          users.map((user) => (
            <tr key={user.id} className="hover:bg-accent/40">
              <td className="px-3 py-2">
                <Link href={`/users/${user.id}`} className="font-medium hover:underline">
                  {user.email}
                </Link>
              </td>
              <td className="px-3 py-2 text-muted-foreground">{user.fullName ?? '—'}</td>
              <td className="px-3 py-2">{user.planSlug}</td>
              <td className="px-3 py-2 text-muted-foreground">{formatDateTime(user.createdAt)}</td>
              <td className="px-3 py-2">
                <UserState bannedAt={user.bannedAt} deletedAt={user.deletedAt} />
              </td>
            </tr>
          ))
        )}
      </DataTable>
      <Pager
        pagination={data?.pagination}
        onPage={(next) => {
          router.push(hrefWith('/users', { q, page: next }))
        }}
      />
    </>
  )
}
