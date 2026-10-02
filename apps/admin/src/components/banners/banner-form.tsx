'use client'

import {
  type AdminBanner,
  BANNER_LEVELS,
  BANNER_MESSAGE_MAX_LENGTH,
  type BannerLevel,
  bannerLevelSchema,
} from '@kaxolax/contracts'
import {
  Alert,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Input,
  Label,
  NativeSelect,
} from '@kaxolax/ui'
import { useId, useState } from 'react'
import { BANNER_LEVEL_LABELS, BannerPreview } from '@/components/ui'
import { adminApi, errorMessage } from '@/lib/api'
import { isoToLocalInput, localInputToIso } from '@/lib/format'

/**
 * Création ou modification d'une bannière, avec aperçu. Dates saisies en heure locale du
 * navigateur, envoyées en ISO avec fuseau ; début vide = maintenant, fin vide = sans fin.
 */
export function BannerForm({
  banner,
  onSaved,
  onCancel,
}: {
  banner: AdminBanner | null
  onSaved: (message: string) => void
  onCancel: () => void
}) {
  const id = useId()
  const [message, setMessage] = useState(banner?.message ?? '')
  const [level, setLevel] = useState<BannerLevel>(banner?.level ?? 'info')
  // Valeurs initiales des champs (à la minute) : une date non retouchée n'est pas renvoyée, pour
  // ne pas tronquer à la minute les dates enregistrées.
  const [initialStartsAt] = useState(() => isoToLocalInput(banner?.startsAt ?? null))
  const [initialEndsAt] = useState(() => isoToLocalInput(banner?.endsAt ?? null))
  const [startsAt, setStartsAt] = useState(initialStartsAt)
  const [endsAt, setEndsAt] = useState(initialEndsAt)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit() {
    const start = localInputToIso(startsAt)
    const end = localInputToIso(endsAt)
    const startChanged = banner === null || startsAt !== initialStartsAt
    const endChanged = banner === null || endsAt !== initialEndsAt
    // Dates comparées telles qu'elles seront enregistrées : saisies si retouchées, sinon celles
    // de la bannière (à la seconde près).
    const effectiveStart: string | null = startChanged ? start : banner.startsAt
    const effectiveEnd = endChanged ? end : banner.endsAt
    if (
      (startChanged || endChanged) &&
      effectiveStart !== null &&
      effectiveEnd !== null &&
      Date.parse(effectiveEnd) <= Date.parse(effectiveStart)
    ) {
      setError('La fin doit être après le début.')
      return
    }
    setBusy(true)
    setError(null)
    try {
      if (banner === null) {
        await adminApi.createBanner({
          message: message.trim(),
          level,
          ...(start === null ? {} : { startsAt: start }),
          endsAt: end,
        })
        onSaved('Bannière créée.')
      } else {
        await adminApi.updateBanner(banner.id, {
          message: message.trim(),
          level,
          // Dates retouchées seulement ; début effacé : on garde celui enregistré.
          ...(startChanged && start !== null ? { startsAt: start } : {}),
          ...(endChanged ? { endsAt: end } : {}),
        })
        onSaved('Bannière modifiée.')
      }
    } catch (caught) {
      setError(errorMessage(caught))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card className="mb-6">
      <CardHeader>
        <CardTitle>{banner === null ? 'Nouvelle bannière' : 'Modifier la bannière'}</CardTitle>
      </CardHeader>
      <CardContent>
        <form
          className="grid gap-4"
          onSubmit={(event) => {
            event.preventDefault()
            void submit()
          }}
        >
          <div className="grid gap-2">
            <Label htmlFor={`${id}-message`}>Message</Label>
            <Input
              id={`${id}-message`}
              required
              maxLength={BANNER_MESSAGE_MAX_LENGTH}
              value={message}
              onChange={(event) => {
                setMessage(event.target.value)
              }}
            />
            <p className="text-xs text-muted-foreground">
              Une ligne, {BANNER_MESSAGE_MAX_LENGTH} caractères au plus ({message.length}).
            </p>
          </div>
          <div className="grid gap-4 sm:grid-cols-3">
            <div className="grid gap-2">
              <Label htmlFor={`${id}-level`}>Niveau</Label>
              <NativeSelect
                id={`${id}-level`}
                className="h-9"
                value={level}
                onChange={(event) => {
                  const parsed = bannerLevelSchema.safeParse(event.target.value)
                  if (parsed.success) setLevel(parsed.data)
                }}
              >
                {BANNER_LEVELS.map((value) => (
                  <option key={value} value={value}>
                    {BANNER_LEVEL_LABELS[value]}
                  </option>
                ))}
              </NativeSelect>
            </div>
            <div className="grid gap-2">
              <Label htmlFor={`${id}-start`}>Début (vide : maintenant)</Label>
              <Input
                id={`${id}-start`}
                type="datetime-local"
                value={startsAt}
                onChange={(event) => {
                  setStartsAt(event.target.value)
                }}
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor={`${id}-end`}>Fin (vide : sans fin)</Label>
              <Input
                id={`${id}-end`}
                type="datetime-local"
                value={endsAt}
                onChange={(event) => {
                  setEndsAt(event.target.value)
                }}
              />
            </div>
          </div>
          <div className="grid gap-2">
            <span className="text-sm font-medium">Aperçu</span>
            <BannerPreview level={level} message={message} />
          </div>
          {error !== null ? <Alert variant="destructive">{error}</Alert> : null}
          <div className="flex gap-2">
            <Button type="submit" disabled={busy || message.trim() === ''}>
              {busy ? 'Enregistrement…' : banner === null ? 'Publier' : 'Enregistrer'}
            </Button>
            <Button type="button" variant="outline" onClick={onCancel} disabled={busy}>
              Annuler
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  )
}
