'use client'

import { Button, Card, CardContent, CardHeader, CardTitle } from '@kaxolax/ui'
import { ArrowLeft } from 'lucide-react'
import Link from 'next/link'
import { DataTable, EmptyRow, ErrorAlert, Field, PageHeader } from '@/components/ui'
import { useApiData } from '@/components/use-api-data'
import { adminApi } from '@/lib/api'
import { formatBytes, formatDateTime } from '@/lib/format'
import {
  organizationPlanText,
  projectStateText,
  seatsSummary,
  WORKSPACE_ROLE_NAMES,
} from '@/lib/organizations'

/**
 * Fiche d'une organisation : plan et abonnement, sièges, stockage mutualisé, membres (rôles
 * d'après Clerk) et projets du workspace d'équipe (métadonnées seulement). Lecture seule.
 */
export function OrganizationScreen({ organizationId }: { organizationId: string }) {
  const { data, error, loading } = useApiData(
    () => adminApi.organization(organizationId),
    organizationId,
  )

  const back = (
    <Button variant="ghost" size="sm" asChild>
      <Link href="/organizations">
        <ArrowLeft aria-hidden />
        Organisations
      </Link>
    </Button>
  )

  if (data === null) {
    return (
      <>
        {back}
        <ErrorAlert message={error} />
        {loading ? <p className="mt-4 text-sm text-muted-foreground">Chargement…</p> : null}
      </>
    )
  }

  const { organization, members, projects, projectTotal } = data
  return (
    <>
      {back}
      <PageHeader
        title={organization.name}
        description={`Organisation Clerk ${organization.clerkOrganizationId}`}
      />
      <ErrorAlert message={error} />
      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Équipe</CardTitle>
          </CardHeader>
          <CardContent>
            <dl>
              <Field label="Plan">{organizationPlanText(organization)}</Field>
              <Field label="Sièges">{seatsSummary(organization)}</Field>
              <Field label="Projets">{organization.projectCount}</Field>
              <Field label="Stockage mutualisé">{formatBytes(organization.storageBytes)}</Field>
              <Field label="Slug">{organization.slug ?? '—'}</Field>
              <Field label="Workspace">
                {organization.workspaceId ?? 'pas encore synchronisé'}
              </Field>
              <Field label="Responsable">
                {organization.owner ? (
                  <Link href={`/users/${organization.owner.id}`} className="hover:underline">
                    {organization.owner.email}
                  </Link>
                ) : (
                  '—'
                )}
              </Field>
              <Field label="Création">{formatDateTime(organization.createdAt)}</Field>
              {organization.deletedAt !== null ? (
                <Field label="Supprimée">{formatDateTime(organization.deletedAt)}</Field>
              ) : null}
            </dl>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Membres</CardTitle>
          </CardHeader>
          <CardContent>
            <DataTable head={['Email', 'Rôle', 'Arrivée']}>
              {members.length === 0 ? (
                <EmptyRow colSpan={3} loading={false} />
              ) : (
                members.map((member) => (
                  <tr key={member.user.id}>
                    <td className="px-3 py-2">
                      <Link href={`/users/${member.user.id}`} className="hover:underline">
                        {member.user.email}
                      </Link>
                      {member.user.fullName ? (
                        <div className="text-xs text-muted-foreground">{member.user.fullName}</div>
                      ) : null}
                    </td>
                    <td className="px-3 py-2">{WORKSPACE_ROLE_NAMES[member.role]}</td>
                    <td className="px-3 py-2 text-muted-foreground">
                      {formatDateTime(member.joinedAt)}
                    </td>
                  </tr>
                ))
              )}
            </DataTable>
          </CardContent>
        </Card>
      </div>
      <h2 className="mt-8 mb-3 text-lg font-semibold">
        Projets
        {projectTotal > projects.length
          ? ` (${String(projects.length)} plus récents sur ${String(projectTotal)})`
          : null}
      </h2>
      <DataTable head={['Nom', 'Propriétaire', 'État', 'Modifié']}>
        {projects.length === 0 ? (
          <EmptyRow colSpan={4} loading={false} />
        ) : (
          projects.map((project) => (
            <tr key={project.id} className="hover:bg-accent/40">
              <td className="px-3 py-2">
                <Link href={`/projects/${project.id}`} className="font-medium hover:underline">
                  {project.name}
                </Link>
              </td>
              <td className="px-3 py-2">{project.owner.email}</td>
              <td className="px-3 py-2">{projectStateText(project)}</td>
              <td className="px-3 py-2 text-muted-foreground">
                {formatDateTime(project.updatedAt)}
              </td>
            </tr>
          ))
        )}
      </DataTable>
    </>
  )
}
