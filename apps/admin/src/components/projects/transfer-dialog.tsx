'use client'

import type { AdminProjectDetail, AdminUserSummary } from '@kaxolax/contracts'
import {
  Alert,
  Button,
  cn,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
} from '@kaxolax/ui'
import { useEffect, useState } from 'react'
import { adminApi, errorMessage } from '@/lib/api'

/** Attente après la dernière frappe avant de chercher. */
const SEARCH_DELAY_MS = 300

/**
 * Transfert de propriété : recherche du destinataire (compte existant, ni supprimé ni banni), puis
 * confirmation. Le nouveau propriétaire reçoit le projet dans son workspace personnel.
 */
export function TransferDialog({
  project,
  open,
  onOpenChange,
  onTransferred,
}: {
  project: AdminProjectDetail
  open: boolean
  onOpenChange: (open: boolean) => void
  onTransferred: (project: AdminProjectDetail) => void
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        {open ? (
          <TransferBody
            project={project}
            onCancel={() => {
              onOpenChange(false)
            }}
            onTransferred={onTransferred}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  )
}

function TransferBody({
  project,
  onCancel,
  onTransferred,
}: {
  project: AdminProjectDetail
  onCancel: () => void
  onTransferred: (project: AdminProjectDetail) => void
}) {
  const [q, setQ] = useState('')
  const [results, setResults] = useState<{ q: string; users: AdminUserSummary[] } | null>(null)
  const [selected, setSelected] = useState<AdminUserSummary | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Erreur de la dernière recherche seulement : effacée par la recherche suivante.
  const [searchError, setSearchError] = useState<string | null>(null)
  const term = q.trim()

  useEffect(() => {
    if (term === '') return
    let active = true
    const timer = setTimeout(() => {
      setSearchError(null)
      adminApi.users(term, 1).then(
        ({ users }) => {
          if (active) setResults({ q: term, users })
        },
        (caught: unknown) => {
          if (active) setSearchError(errorMessage(caught))
        },
      )
    }, SEARCH_DELAY_MS)
    return () => {
      active = false
      clearTimeout(timer)
    }
  }, [term])

  const candidates =
    term === '' || results?.q !== term
      ? []
      : results.users.filter(
          (user) =>
            user.deletedAt === null && user.bannedAt === null && user.id !== project.owner.id,
        )

  async function transfer(target: AdminUserSummary) {
    setBusy(true)
    setError(null)
    try {
      onTransferred(await adminApi.transferProject(project.id, target.id))
    } catch (caught) {
      setError(errorMessage(caught))
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle>Transférer la propriété</DialogTitle>
        <DialogDescription>
          « {project.name} » appartient à {project.owner.email}. L'ancien propriétaire reste membre
          en tant qu'éditeur.
        </DialogDescription>
      </DialogHeader>
      <Input
        type="search"
        placeholder="Rechercher le destinataire (email, nom ou id)"
        aria-label="Destinataire"
        value={q}
        autoFocus
        onChange={(event) => {
          setQ(event.target.value)
          setSelected(null)
        }}
      />
      <ul
        className="max-h-60 divide-y overflow-y-auto rounded-md border"
        aria-label="Comptes trouvés"
      >
        {candidates.length === 0 ? (
          <li className="px-3 py-3 text-sm text-muted-foreground">
            {term === ''
              ? 'Saisissez au moins un caractère.'
              : results?.q === term
                ? 'Aucun compte.'
                : 'Recherche…'}
          </li>
        ) : (
          candidates.map((user) => (
            <li key={user.id}>
              <button
                type="button"
                aria-pressed={selected?.id === user.id}
                className={cn(
                  'flex w-full flex-col items-start px-3 py-2 text-left text-sm hover:bg-accent',
                  selected?.id === user.id && 'bg-accent',
                )}
                onClick={() => {
                  setSelected(user)
                }}
              >
                <span className="font-medium">{user.email}</span>
                <span className="text-xs text-muted-foreground">{user.fullName ?? 'Sans nom'}</span>
              </button>
            </li>
          ))
        )}
      </ul>
      {searchError !== null ? <Alert variant="destructive">{searchError}</Alert> : null}
      {error !== null ? <Alert variant="destructive">{error}</Alert> : null}
      <DialogFooter>
        <Button variant="outline" onClick={onCancel} disabled={busy}>
          Annuler
        </Button>
        <Button
          disabled={busy || selected === null}
          onClick={() => {
            if (selected !== null) void transfer(selected)
          }}
        >
          {busy
            ? 'Transfert…'
            : selected === null
              ? 'Transférer'
              : `Transférer à ${selected.email}`}
        </Button>
      </DialogFooter>
    </>
  )
}
