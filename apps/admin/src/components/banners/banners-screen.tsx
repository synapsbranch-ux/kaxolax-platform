'use client'

import type { AdminBanner, BannerStatus } from '@kaxolax/contracts'
import { Alert, Badge, Button } from '@kaxolax/ui'
import { Plus } from 'lucide-react'
import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { BannerForm } from '@/components/banners/banner-form'
import { ConfirmDialog, type ConfirmRequest } from '@/components/confirm-dialog'
import { DataTable, EmptyRow, ErrorAlert, LevelBadge, PageHeader, Pager } from '@/components/ui'
import { useApiData } from '@/components/use-api-data'
import { adminApi } from '@/lib/api'
import { formatDateTime } from '@/lib/format'
import { hrefWith } from '@/lib/search-params'

const STATUS_LABELS: Record<BannerStatus, string> = {
  scheduled: 'Programmée',
  active: 'Affichée',
  ended: 'Terminée',
}

/** Formulaire ouvert : création (`null`) ou modification d'une bannière. */
type Editing = { banner: AdminBanner | null } | null

/**
 * Bannières système : affichées en haut de l'application pour tous les utilisateurs connectés
 * entre leur début et leur fin.
 */
export function BannersScreen({ page }: { page: number }) {
  const router = useRouter()
  const { data, error, loading, reload } = useApiData(() => adminApi.banners(page), String(page))
  const [editing, setEditing] = useState<Editing>(null)
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const banners = data?.banners ?? []

  return (
    <>
      <PageHeader
        title="Bannière système"
        description="Message en haut de l'application pour tous les utilisateurs connectés (rafraîchi chaque minute)."
      >
        <Button
          onClick={() => {
            setNotice(null)
            setEditing({ banner: null })
          }}
        >
          <Plus aria-hidden />
          Nouvelle bannière
        </Button>
      </PageHeader>
      <ErrorAlert message={error} />
      {notice !== null ? (
        <Alert variant="success" className="mb-4">
          {notice}
        </Alert>
      ) : null}
      {editing !== null ? (
        <BannerForm
          key={editing.banner?.id ?? 'new'}
          banner={editing.banner}
          onCancel={() => {
            setEditing(null)
          }}
          onSaved={(message) => {
            setEditing(null)
            setNotice(message)
            reload()
          }}
        />
      ) : null}
      <DataTable head={['Message', 'Niveau', 'Début', 'Fin', 'État', 'Auteur', '']}>
        {banners.length === 0 ? (
          <EmptyRow colSpan={7} loading={loading} />
        ) : (
          banners.map((banner) => (
            <tr key={banner.id}>
              <td className="max-w-md px-3 py-2">{banner.message}</td>
              <td className="px-3 py-2">
                <LevelBadge level={banner.level} />
              </td>
              <td className="px-3 py-2 text-muted-foreground">{formatDateTime(banner.startsAt)}</td>
              <td className="px-3 py-2 text-muted-foreground">
                {banner.endsAt === null ? 'Sans fin' : formatDateTime(banner.endsAt)}
              </td>
              <td className="px-3 py-2">
                <Badge variant={banner.status === 'active' ? 'default' : 'outline'}>
                  {STATUS_LABELS[banner.status]}
                </Badge>
              </td>
              <td className="px-3 py-2 text-muted-foreground">{banner.createdBy.email}</td>
              <td className="px-3 py-2">
                <div className="flex justify-end gap-1">
                  {banner.status === 'active' ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        setNotice(null)
                        setConfirm({
                          title: 'Terminer cette bannière ?',
                          description:
                            'Elle disparaît de l’application à la prochaine actualisation.',
                          confirmLabel: 'Terminer',
                          action: async () => {
                            // Fin posée à l'heure du serveur plutôt que suppression : l'historique
                            // reste visible.
                            await adminApi.endBanner(banner.id)
                            setNotice('Bannière terminée.')
                            reload()
                          },
                        })
                      }}
                    >
                      Terminer
                    </Button>
                  ) : null}
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      setNotice(null)
                      setEditing({ banner })
                    }}
                  >
                    Modifier
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-destructive"
                    onClick={() => {
                      setNotice(null)
                      setConfirm({
                        title: 'Supprimer cette bannière ?',
                        description: banner.message,
                        confirmLabel: 'Supprimer',
                        destructive: true,
                        action: async () => {
                          await adminApi.deleteBanner(banner.id)
                          setNotice('Bannière supprimée.')
                          reload()
                        },
                      })
                    }}
                  >
                    Supprimer
                  </Button>
                </div>
              </td>
            </tr>
          ))
        )}
      </DataTable>
      <Pager
        pagination={data?.pagination}
        onPage={(next) => {
          router.push(hrefWith('/banners', { page: next }))
        }}
      />
      <ConfirmDialog
        request={confirm}
        onClose={() => {
          setConfirm(null)
        }}
      />
    </>
  )
}
