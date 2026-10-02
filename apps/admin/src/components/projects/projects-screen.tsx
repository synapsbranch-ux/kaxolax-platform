'use client'

import type { AdminProjectView } from '@kaxolax/contracts'
import { NativeSelect } from '@kaxolax/ui'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { ProjectState } from '@/components/projects/project-state'
import { SearchForm } from '@/components/search-form'
import { DataTable, EmptyRow, ErrorAlert, PageHeader, Pager } from '@/components/ui'
import { useApiData } from '@/components/use-api-data'
import { adminApi } from '@/lib/api'
import { formatBytes, formatDateTime } from '@/lib/format'
import { hrefWith } from '@/lib/search-params'

const VIEW_LABELS: Record<AdminProjectView, string> = {
  all: 'Tous',
  active: 'Actifs',
  archived: 'Archivés',
  trashed: 'Corbeille',
}

/** Liste des projets : recherche par nom, propriétaire (email ou id) ou id, filtre d'état. */
export function ProjectsScreen({
  q,
  view,
  page,
}: {
  q: string
  view: AdminProjectView
  page: number
}) {
  const router = useRouter()
  const { data, error, loading } = useApiData(
    () => adminApi.projects(q, view, page),
    `${q}|${view}|${String(page)}`,
  )
  const projects = data?.projects ?? []

  return (
    <>
      <PageHeader title="Projets" description="Métadonnées seulement : aucun accès au contenu.">
        <NativeSelect
          aria-label="État"
          className="h-9"
          value={view}
          onChange={(event) => {
            router.push(hrefWith('/projects', { q, view: event.target.value }))
          }}
        >
          {Object.entries(VIEW_LABELS).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </NativeSelect>
        <SearchForm
          initial={q}
          placeholder="Nom, propriétaire ou id"
          onSearch={(value) => {
            router.push(hrefWith('/projects', { q: value, view }))
          }}
        />
      </PageHeader>
      <ErrorAlert message={error} />
      <DataTable head={['Nom', 'Propriétaire', 'Taille', 'Membres', 'Modifié', 'État']}>
        {projects.length === 0 ? (
          <EmptyRow colSpan={6} loading={loading} />
        ) : (
          projects.map((project) => (
            <tr key={project.id} className="hover:bg-accent/40">
              <td className="px-3 py-2">
                <Link href={`/projects/${project.id}`} className="font-medium hover:underline">
                  {project.name}
                </Link>
              </td>
              <td className="px-3 py-2">
                <Link
                  href={`/users/${project.owner.id}`}
                  className="text-muted-foreground hover:underline"
                >
                  {project.owner.email}
                </Link>
              </td>
              <td className="px-3 py-2 tabular-nums">{formatBytes(project.sizeBytes)}</td>
              <td className="px-3 py-2 tabular-nums">{project.memberCount}</td>
              <td className="px-3 py-2 text-muted-foreground">
                {formatDateTime(project.updatedAt)}
              </td>
              <td className="px-3 py-2">
                <ProjectState archivedAt={project.archivedAt} trashedAt={project.trashedAt} />
              </td>
            </tr>
          ))
        )}
      </DataTable>
      <Pager
        pagination={data?.pagination}
        onPage={(next) => {
          router.push(hrefWith('/projects', { q, view, page: next }))
        }}
      />
    </>
  )
}
