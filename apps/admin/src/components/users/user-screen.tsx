'use client'

import type { AdminUserDetail } from '@kaxolax/contracts'
import { Alert, Button, Card, CardContent, CardHeader, CardTitle } from '@kaxolax/ui'
import { ArrowLeft } from 'lucide-react'
import Link from 'next/link'
import { useState } from 'react'
import { ConfirmDialog, type ConfirmRequest } from '@/components/confirm-dialog'
import { ErrorAlert, Field, PageHeader } from '@/components/ui'
import { useApiData } from '@/components/use-api-data'
import { UserState } from '@/components/users/user-state'
import { adminApi } from '@/lib/api'
import { formatBytes, formatDateTime } from '@/lib/format'
import { hrefWith } from '@/lib/search-params'

function limitsText(user: AdminUserDetail): string {
  const limits = user.plan.limits
  if (limits === null) return 'Limites inconnues pour ce plan'
  const collaborators =
    limits.maxCollaborators === null ? 'illimités' : String(limits.maxCollaborators)
  const history =
    limits.historyRetentionDays === null ? 'complet' : `${String(limits.historyRetentionDays)} j`
  return `Compilation ${String(limits.maxCompileSeconds)} s · collaborateurs ${collaborators} · historique ${history} · stockage ${formatBytes(limits.storageBytes)}`
}

/** Message après une action ; avertissement si les documents temps réel n'ont pas été fermés. */
interface Notice {
  text: string
  warning: boolean
}

const REALTIME_WARNING =
  " Attention : le service temps réel n'a pas répondu, ses documents ouverts peuvent le rester. Réessayez avec « Révoquer les sessions »."

/** Ajoute l'avertissement temps réel au message quand la déconnexion a échoué. */
function realtimeNotice(text: string, realtimeDisconnected: boolean): Notice {
  return realtimeDisconnected
    ? { text, warning: false }
    : { text: text + REALTIME_WARNING, warning: true }
}

/** Fiche d'un utilisateur et actions (via l'API Backend de Clerk, côté API). */
export function UserScreen({ userId }: { userId: string }) {
  const { data: user, error, loading, reload } = useApiData(() => adminApi.user(userId), userId)
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null)
  const [notice, setNotice] = useState<Notice | null>(null)

  const back = (
    <Button variant="ghost" size="sm" asChild>
      <Link href="/users">
        <ArrowLeft aria-hidden />
        Utilisateurs
      </Link>
    </Button>
  )

  if (user === null) {
    return (
      <>
        {back}
        <ErrorAlert message={error} />
        {loading ? <p className="mt-4 text-sm text-muted-foreground">Chargement…</p> : null}
      </>
    )
  }

  const deleted = user.deletedAt !== null
  const banned = user.bannedAt !== null

  function act(request: Omit<ConfirmRequest, 'action'>, action: () => Promise<Notice>) {
    setNotice(null)
    setConfirm({
      ...request,
      action: async () => {
        setNotice(await action())
        reload()
      },
    })
  }

  return (
    <>
      {back}
      <PageHeader title={user.fullName ?? user.email} description={user.email}>
        <UserState bannedAt={user.bannedAt} deletedAt={user.deletedAt} />
      </PageHeader>
      <ErrorAlert message={error} />
      {notice !== null ? (
        <Alert variant={notice.warning ? 'destructive' : 'success'} className="mb-4">
          {notice.text}
        </Alert>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Compte</CardTitle>
          </CardHeader>
          <CardContent>
            <dl>
              <Field label="Id">
                <span className="font-mono text-xs">{user.id}</span>
              </Field>
              <Field label="Id Clerk">
                <span className="font-mono text-xs">{user.clerkUserId}</span>
              </Field>
              <Field label="Inscription">{formatDateTime(user.createdAt)}</Field>
              <Field label="Dernière connexion">
                {user.clerk === null ? 'Inconnue (Clerk)' : formatDateTime(user.clerk.lastSignInAt)}
              </Field>
              <Field label="Dernière activité">
                {user.clerk === null ? 'Inconnue (Clerk)' : formatDateTime(user.clerk.lastActiveAt)}
              </Field>
              <Field label="MFA">
                {user.clerk === null ? '—' : user.clerk.twoFactorEnabled ? 'Activée' : 'Désactivée'}
              </Field>
              <Field label="Banni">{banned ? formatDateTime(user.bannedAt) : 'Non'}</Field>
              {deleted ? <Field label="Supprimé">{formatDateTime(user.deletedAt)}</Field> : null}
            </dl>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Plan et usage</CardTitle>
          </CardHeader>
          <CardContent>
            <dl>
              <Field label="Plan">
                {user.plan.slug}
                {user.plan.status !== null ? ` (${user.plan.status})` : ''}
              </Field>
              <Field label="Fin de période">{formatDateTime(user.plan.periodEnd)}</Field>
              <Field label="Limites">{limitsText(user)}</Field>
              <Field label="Projets possédés">
                <Link className="hover:underline" href={hrefWith('/projects', { q: user.id })}>
                  {user.ownedProjects}
                </Link>
              </Field>
              <Field label="Projets partagés">{user.memberProjects}</Field>
              <Field label="Stockage utilisé">{formatBytes(user.storageBytes)}</Field>
            </dl>
          </CardContent>
        </Card>
      </div>

      <Card className="mt-4">
        <CardHeader>
          <CardTitle>Actions</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-2">
          {banned ? (
            <Button
              variant="outline"
              disabled={deleted}
              onClick={() => {
                act(
                  {
                    title: 'Débannir ce compte ?',
                    description: `${user.email} pourra de nouveau se connecter.`,
                    confirmLabel: 'Débannir',
                  },
                  async () => {
                    await adminApi.unbanUser(user.id)
                    return { text: 'Compte débanni.', warning: false }
                  },
                )
              }}
            >
              Débannir
            </Button>
          ) : (
            <Button
              variant="destructive"
              disabled={deleted}
              onClick={() => {
                act(
                  {
                    title: 'Bannir ce compte ?',
                    description: `${user.email} est déconnecté immédiatement (sessions révoquées, documents fermés) et ne peut plus se reconnecter.`,
                    confirmLabel: 'Bannir',
                    destructive: true,
                  },
                  async () => {
                    const { realtimeDisconnected } = await adminApi.banUser(user.id)
                    return realtimeNotice('Compte banni et déconnecté.', realtimeDisconnected)
                  },
                )
              }}
            >
              Bannir
            </Button>
          )}
          <Button
            variant="outline"
            disabled={deleted}
            onClick={() => {
              act(
                {
                  title: 'Révoquer toutes les sessions ?',
                  description: `${user.email} est déconnecté de tous ses appareils (jetons en cours refusés, documents fermés) ; il peut se reconnecter en ouvrant une nouvelle session.`,
                  confirmLabel: 'Révoquer',
                },
                async () => {
                  const { revokedSessions: count, realtimeDisconnected } =
                    await adminApi.revokeSessions(user.id)
                  return realtimeNotice(
                    `${String(count)} session${count > 1 ? 's' : ''} révoquée${count > 1 ? 's' : ''}.`,
                    realtimeDisconnected,
                  )
                },
              )
            }}
          >
            Révoquer les sessions
          </Button>
          <Button
            variant="destructive"
            disabled={deleted}
            onClick={() => {
              act(
                {
                  title: 'Supprimer ce compte ?',
                  description:
                    'Le compte est supprimé dans Clerk et anonymisé ; ses projets sont supprimés et il est retiré des projets partagés. Irréversible.',
                  confirmLabel: 'Supprimer le compte',
                  destructive: true,
                  typeToConfirm: user.email,
                },
                async () => {
                  const { realtimeDisconnected } = await adminApi.deleteUser(user.id)
                  return realtimeNotice('Compte supprimé.', realtimeDisconnected)
                },
              )
            }}
          >
            Supprimer le compte
          </Button>
          <Button variant="ghost" asChild>
            <Link href={hrefWith('/audit-log', { targetType: 'user', targetId: user.id })}>
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
    </>
  )
}
