'use client'

import {
  Alert,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
} from '@kaxolax/ui'
import { useId, useState } from 'react'
import { errorMessage } from '@/lib/api'

export interface ConfirmRequest {
  title: string
  description: string
  confirmLabel: string
  destructive?: boolean
  /** Texte à recopier pour confirmer (actions irréversibles). */
  typeToConfirm?: string
  action: () => Promise<void>
}

/**
 * Confirmation d'une action de l'admin. L'action est attendue : en cas d'erreur, le message
 * s'affiche dans la boîte, qui reste ouverte.
 */
export function ConfirmDialog({
  request,
  onClose,
}: {
  request: ConfirmRequest | null
  onClose: () => void
}) {
  return (
    <Dialog
      open={request !== null}
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    >
      <DialogContent>
        {/* Nouvelle boîte à chaque demande : saisie et erreur repartent de zéro. */}
        {request ? <ConfirmBody key={request.title} request={request} onClose={onClose} /> : null}
      </DialogContent>
    </Dialog>
  )
}

function ConfirmBody({ request, onClose }: { request: ConfirmRequest; onClose: () => void }) {
  const inputId = useId()
  const [typed, setTyped] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const blocked = request.typeToConfirm !== undefined && typed.trim() !== request.typeToConfirm

  async function confirm() {
    setBusy(true)
    setError(null)
    try {
      await request.action()
      onClose()
    } catch (caught) {
      setError(errorMessage(caught))
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle>{request.title}</DialogTitle>
        <DialogDescription>{request.description}</DialogDescription>
      </DialogHeader>
      {request.typeToConfirm !== undefined ? (
        <div className="grid gap-2">
          <Label htmlFor={inputId}>
            Recopiez <span className="font-mono">{request.typeToConfirm}</span> pour confirmer
          </Label>
          <Input
            id={inputId}
            value={typed}
            autoComplete="off"
            onChange={(event) => {
              setTyped(event.target.value)
            }}
          />
        </div>
      ) : null}
      {error !== null ? <Alert variant="destructive">{error}</Alert> : null}
      <DialogFooter>
        <Button variant="outline" onClick={onClose} disabled={busy}>
          Annuler
        </Button>
        <Button
          variant={request.destructive === true ? 'destructive' : 'default'}
          disabled={busy || blocked}
          onClick={() => {
            void confirm()
          }}
        >
          {busy ? 'En cours…' : request.confirmLabel}
        </Button>
      </DialogFooter>
    </>
  )
}
