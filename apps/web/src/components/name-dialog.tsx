'use client'

import {
  Alert,
  Button,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
} from '@kaxolax/ui'
import { type SubmitEvent, useState } from 'react'
import { errorMessage, formValue } from '@/lib/api'

/** Boîte de dialogue qui demande un nom (création, renommage). */
export function NameDialog({
  open,
  title,
  label,
  initialValue = '',
  submitLabel,
  onSubmit,
  onOpenChange,
}: {
  open: boolean
  title: string
  label: string
  initialValue?: string
  submitLabel: string
  onSubmit: (name: string) => Promise<void>
  onOpenChange: (open: boolean) => void
}) {
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)

  async function submit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault()
    const name = formValue(new FormData(event.currentTarget), 'name').trim()
    if (name === '') return
    setPending(true)
    setError(null)
    try {
      await onSubmit(name)
      onOpenChange(false)
    } catch (caught) {
      setError(errorMessage(caught))
    } finally {
      setPending(false)
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setError(null)
        onOpenChange(next)
      }}
    >
      <DialogContent>
        <form onSubmit={(event) => void submit(event)} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
          </DialogHeader>
          {error ? <Alert variant="destructive">{error}</Alert> : null}
          <div className="grid gap-2">
            <Label htmlFor="name-dialog-input">{label}</Label>
            <Input
              id="name-dialog-input"
              name="name"
              defaultValue={initialValue}
              autoFocus
              required
              maxLength={255}
            />
          </div>
          <DialogFooter>
            <Button type="submit" disabled={pending}>
              {submitLabel}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
