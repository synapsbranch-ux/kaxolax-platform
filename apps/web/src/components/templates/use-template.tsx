'use client'

import { useAuth } from '@clerk/nextjs'
import type { PlanLimitError, TemplateSummary } from '@kaxolax/contracts'
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
  Spinner,
} from '@kaxolax/ui'
import { FilePlusIcon } from 'lucide-react'
import { useRouter } from 'next/navigation'
import { type SubmitEvent, useEffect, useId, useState } from 'react'
import { PlanLimitNotice } from '@/components/billing/plan-limit-notice'
import { api, ApiError, errorMessage, formValue } from '@/lib/api'
import { markPlanLimitHandled } from '@/lib/plan-limits'
import { authUrl } from '@/lib/sharing'
import { TEAM_PLAN_REQUIRED_MESSAGE } from '@/lib/teams'
import { templateResumeHref } from '@/lib/templates'

/** Messages des refus propres à la galerie (codes `TEMPLATE_ERRORS`). */
function createErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    switch (error.code) {
      case 'E_TEMPLATE_NOT_FOUND':
        return 'Ce template n’existe plus dans la galerie.'
      case 'E_TEMPLATES_UNAVAILABLE':
      case 'E_TEMPLATE_DOWNLOAD_FAILED':
        return 'Le template est momentanément indisponible. Réessayez dans quelques instants.'
      case 'E_TEMPLATE_INTEGRITY':
        return 'Le fichier du template est en cours de mise à jour. Réessayez dans quelques minutes.'
      case 'E_TEAM_PLAN_REQUIRED':
        return TEAM_PLAN_REQUIRED_MESSAGE
      default:
        break
    }
  }
  return errorMessage(error)
}

/**
 * Bouton « Utiliser ce template » : demande le nom du projet (titre du template par défaut), crée
 * le projet (`POST /projects/from-template`) puis ouvre l'éditeur. Sans session : connexion Clerk,
 * puis retour sur la fiche du template (`?use=1`), où la boîte de dialogue se rouvre (`autoOpen`).
 */
export function UseTemplateButton({
  template,
  workspaceId = null,
  autoOpen = false,
  onResumed,
}: {
  template: TemplateSummary
  /** Workspace du projet créé ; null : workspace personnel. */
  workspaceId?: string | null
  /** Ouvre la boîte de dialogue dès que la session est connue (retour de la connexion). */
  autoOpen?: boolean
  /** Appelé une fois la reprise faite (pour retirer `?use=1` de l'URL). */
  onResumed?: () => void
}) {
  const { isLoaded, isSignedIn } = useAuth()
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [planLimit, setPlanLimit] = useState<PlanLimitError | null>(null)
  const inputId = useId()

  // Retour de la connexion : la boîte de dialogue se rouvre, une seule fois.
  const resume = autoOpen && isLoaded && isSignedIn
  useEffect(() => {
    if (!resume) return
    const timer = setTimeout(() => {
      setOpen(true)
      onResumed?.()
    }, 0)
    return () => {
      clearTimeout(timer)
    }
  }, [resume, onResumed])

  function start() {
    if (!isLoaded) return
    if (!isSignedIn) {
      router.push(authUrl('sign-in', templateResumeHref(template.id)))
      return
    }
    setOpen(true)
  }

  async function submit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault()
    const name = formValue(new FormData(event.currentTarget), 'name').trim()
    setPending(true)
    setError(null)
    setPlanLimit(null)
    try {
      const { project } = await api.createProjectFromTemplate({
        templateId: template.id,
        ...(name === '' ? {} : { name }),
        ...(workspaceId === null ? {} : { workspaceId }),
      })
      router.push(`/project/${project.id}`)
    } catch (caught) {
      // Limite du plan (stockage) affichée ici, pas par la boîte de dialogue globale.
      markPlanLimitHandled(caught)
      const limit = caught instanceof ApiError ? caught.planLimit : null
      if (limit !== null) setPlanLimit(limit)
      else setError(createErrorMessage(caught))
      setPending(false)
    }
  }

  return (
    <>
      <Button onClick={start} disabled={!isLoaded} data-testid="use-template">
        <FilePlusIcon /> Utiliser ce template
      </Button>
      <Dialog
        open={open}
        onOpenChange={(next) => {
          if (pending) return
          setError(null)
          setPlanLimit(null)
          setOpen(next)
        }}
      >
        <DialogContent>
          <form onSubmit={(event) => void submit(event)} className="grid gap-4">
            <DialogHeader>
              <DialogTitle>Nouveau projet</DialogTitle>
              <DialogDescription>
                Le projet est créé à partir du template « {template.title} », puis ouvert dans
                l’éditeur.
              </DialogDescription>
            </DialogHeader>
            {error !== null ? <Alert variant="destructive">{error}</Alert> : null}
            {planLimit !== null ? <PlanLimitNotice error={planLimit} /> : null}
            <div className="grid gap-2">
              <Label htmlFor={inputId}>Nom du projet</Label>
              <Input
                id={inputId}
                name="name"
                defaultValue={template.title}
                autoFocus
                required
                maxLength={255}
              />
            </div>
            <DialogFooter>
              <Button type="submit" disabled={pending} data-testid="create-from-template">
                {pending ? <Spinner label="" /> : null}
                {pending ? 'Création…' : 'Créer le projet'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  )
}
