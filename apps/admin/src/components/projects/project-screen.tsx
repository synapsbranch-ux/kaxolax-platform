'use client'

import { Alert, Button, Card, CardContent, CardHeader, CardTitle } from '@kaxolax/ui'
import { ArrowLeft } from 'lucide-react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { ConfirmDialog, type ConfirmRequest } from '@/components/confirm-dialog'
import { ProjectState } from '@/components/projects/project-state'
import { TransferDialog } from '@/components/projects/transfer-dialog'
import { DataTable, ErrorAlert, Field, PageHeader } from '@/components/ui'
import { useApiData } from '@/components/use-api-data'
import { adminApi } from '@/lib/api'
import { formatBytes, formatDateTime, formatDuration } from '@/lib/format'
import { hrefWith } from '@/lib/search-params'

const ROLE_LABELS = {
  owner: 'Propriétaire',
  editor: 'Éditeur',
  reviewer: 'Relecteur',
  viewer: 'Lecteur',
} as const

const STATUS_LABELS = {
  success: 'Réussie',
  failure: 'Erreurs LaTeX',
  timeout: 'Durée dépassée',
  error: 'Erreur du service',
} as const

/** Fiche d'un projet (métadonnées) et actions de l'admin. */
export function ProjectScreen({ projectId }: { projectId: string }) {
  const router = useRouter()
  const { data, error, loading, reload } = useApiData(() => adminApi.project(projectId), projectId)
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null)
  const [transferOpen, setTransferOpen] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)

  const back = (
    <Button variant="ghost" size="sm" asChild>
      <Link href="/projects">
        <ArrowLeft aria-hidden />
        Projets
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
  const project = data
  const trashed = project.trashedAt !== null
  const archived = project.archivedAt !== null

  function changeState(
    action: 'archive' | 'unarchive' | 'trash' | 'restore',
    request: Omit<ConfirmRequest, 'action'>,
    message: string,
  ) {
    setNotice(null)
    setConfirm({
      ...request,
      action: async () => {
        await adminApi.setProjectState(project.id, action)
        setNotice(message)
        reload()
      },
    })
  }

  return (
    <>
      {back}
      <PageHeader title={project.name} description={`Propriétaire : ${project.owner.email}`}>
        <ProjectState archivedAt={project.archivedAt} trashedAt={project.trashedAt} />
      </PageHeader>
      <ErrorAlert message={error} />
      {notice !== null ? (
        <Alert variant="success" className="mb-4">
          {notice}
        </Alert>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Métadonnées</CardTitle>
          </CardHeader>
          <CardContent>
            <dl>
              <Field label="Id">
                <span className="font-mono text-xs">{project.id}</span>
              </Field>
              <Field label="Propriétaire">
                <Link href={`/users/${project.owner.id}`} className="hover:underline">
                  {project.owner.email}
                </Link>
              </Field>
              <Field label="Workspace">
                {project.workspace.name} (
                {project.workspace.type === 'personal' ? 'personnel' : 'équipe'})
              </Field>
              <Field label="Compilateur">{project.compiler}</Field>
              <Field label="Création">{formatDateTime(project.createdAt)}</Field>
              <Field label="Modification">{formatDateTime(project.updatedAt)}</Field>
              {archived ? (
                <Field label="Archivé le">{formatDateTime(project.archivedAt)}</Field>
              ) : null}
              {trashed ? (
                <Field label="Corbeille depuis">{formatDateTime(project.trashedAt)}</Field>
              ) : null}
            </dl>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Taille et compilation</CardTitle>
          </CardHeader>
          <CardContent>
            <dl>
              <Field label="Taille totale">{formatBytes(project.sizeBytes)}</Field>
              <Field label="Fichiers binaires">
                {project.fileCount} · {formatBytes(project.storage.filesBytes)}
              </Field>
              <Field label="Documents">
                {project.documentCount} · {formatBytes(project.storage.documentsBytes)}
              </Field>
              <Field label="Dossiers">{project.folderCount}</Field>
              <Field label="Dernière compilation">
                {project.lastCompile === null
                  ? 'Jamais compilé'
                  : `${formatDateTime(project.lastCompile.createdAt)} · ${STATUS_LABELS[project.lastCompile.status]} · ${formatDuration(project.lastCompile.durationMs)}`}
              </Field>
              {project.lastCompile !== null ? (
                <Field label="Agent">{project.lastCompile.agentId ?? '—'}</Field>
              ) : null}
            </dl>
          </CardContent>
        </Card>
      </div>

      <h2 className="mt-6 mb-2 text-sm font-semibold">Membres ({project.members.length})</h2>
      <DataTable head={['Compte', 'Rôle', 'Depuis']}>
        {project.members.map((member) => (
          <tr key={member.user.id}>
            <td className="px-3 py-2">
              <Link href={`/users/${member.user.id}`} className="hover:underline">
                {member.user.email}
              </Link>
            </td>
            <td className="px-3 py-2">{ROLE_LABELS[member.role]}</td>
            <td className="px-3 py-2 text-muted-foreground">{formatDateTime(member.createdAt)}</td>
          </tr>
        ))}
      </DataTable>

      <Card className="mt-6">
        <CardHeader>
          <CardTitle>Actions</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            disabled={trashed}
            onClick={() => {
              setNotice(null)
              setTransferOpen(true)
            }}
          >
            Transférer la propriété
          </Button>
          {archived ? (
            <Button
              variant="outline"
              disabled={trashed}
              onClick={() => {
                changeState(
                  'unarchive',
                  {
                    title: 'Désarchiver ce projet ?',
                    description:
                      'Le projet revient dans la liste des projets actifs de ses membres.',
                    confirmLabel: 'Désarchiver',
                  },
                  'Projet désarchivé.',
                )
              }}
            >
              Désarchiver
            </Button>
          ) : (
            <Button
              variant="outline"
              disabled={trashed}
              onClick={() => {
                changeState(
                  'archive',
                  {
                    title: 'Archiver ce projet ?',
                    description: 'Le projet passe dans les archives de ses membres.',
                    confirmLabel: 'Archiver',
                  },
                  'Projet archivé.',
                )
              }}
            >
              Archiver
            </Button>
          )}
          {trashed ? (
            <>
              <Button
                variant="outline"
                onClick={() => {
                  changeState(
                    'restore',
                    {
                      title: 'Restaurer ce projet ?',
                      description: 'Le projet sort de la corbeille.',
                      confirmLabel: 'Restaurer',
                    },
                    'Projet restauré.',
                  )
                }}
              >
                Restaurer
              </Button>
              <Button
                variant="destructive"
                onClick={() => {
                  setNotice(null)
                  setConfirm({
                    title: 'Supprimer définitivement ce projet ?',
                    description:
                      'Documents, fichiers, compilations et membres sont supprimés ; les collaborateurs connectés sont déconnectés. Irréversible.',
                    confirmLabel: 'Supprimer définitivement',
                    destructive: true,
                    typeToConfirm: project.name,
                    action: async () => {
                      await adminApi.deleteProject(project.id)
                      router.push('/projects')
                    },
                  })
                }}
              >
                Supprimer définitivement
              </Button>
            </>
          ) : (
            <Button
              variant="destructive"
              onClick={() => {
                changeState(
                  'trash',
                  {
                    title: 'Mettre ce projet à la corbeille ?',
                    description:
                      'Il pourra être restauré tant qu’il n’est pas supprimé définitivement.',
                    confirmLabel: 'Mettre à la corbeille',
                    destructive: true,
                  },
                  'Projet mis à la corbeille.',
                )
              }}
            >
              Mettre à la corbeille
            </Button>
          )}
          <Button variant="ghost" asChild>
            <Link href={hrefWith('/audit-log', { targetType: 'project', targetId: project.id })}>
              Voir le journal
            </Link>
          </Button>
        </CardContent>
      </Card>

      <ConfirmDialog
        request={confirm}
        onClose={() => {
          setConfirm(null)
        }}
      />
      <TransferDialog
        project={project}
        open={transferOpen}
        onOpenChange={setTransferOpen}
        onTransferred={(updated) => {
          setTransferOpen(false)
          setNotice(`Propriété transférée à ${updated.owner.email}.`)
          reload()
        }}
      />
    </>
  )
}
