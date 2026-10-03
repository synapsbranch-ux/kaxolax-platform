'use client'

import type { Workspace } from '@kaxolax/contracts'
import {
  Alert,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Label,
  NativeSelect,
} from '@kaxolax/ui'
import { type SubmitEvent, useState } from 'react'
import { api, ApiError, errorMessage, formValue, type Project } from '@/lib/api'
import { markPlanLimitHandled, planLimitMessage } from '@/lib/plan-limits'
import { TEAM_ROLE_LABELS, teamErrorMessage } from '@/lib/teams'

/**
 * Déplacement d'un projet personnel vers une équipe (`POST /projects/:id/move`) : choix de
 * l'équipe, conséquences (accès des membres, stockage et limites du plan de l'équipe). Un refus
 * de limite du plan de l'équipe s'affiche dans la boîte.
 */
export function MoveProjectDialog({
  project,
  teams,
  onOpenChange,
  onMoved,
}: {
  /** Projet à déplacer ; null : boîte fermée. */
  project: Project | null
  /** Équipes possibles (`moveTargets`). */
  teams: readonly Workspace[]
  onOpenChange: (open: boolean) => void
  onMoved: (project: Project, team: Workspace) => void
}) {
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)

  async function submit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault()
    if (project === null) return
    const team = teams.find(
      (candidate) => candidate.id === formValue(new FormData(event.currentTarget), 'team'),
    )
    if (team === undefined) return
    setPending(true)
    setError(null)
    try {
      const moved = await api.moveProject(project.id, team.id)
      onMoved(moved.project, team)
      onOpenChange(false)
    } catch (caught) {
      markPlanLimitHandled(caught)
      const limit = caught instanceof ApiError ? caught.planLimit : null
      setError(
        limit === null
          ? teamErrorMessage(caught, errorMessage)
          : planLimitMessage(limit).description,
      )
    } finally {
      setPending(false)
    }
  }

  return (
    <Dialog
      open={project !== null}
      onOpenChange={(next) => {
        setError(null)
        onOpenChange(next)
      }}
    >
      <DialogContent data-testid="move-project-dialog">
        <form onSubmit={(event) => void submit(event)} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>Déplacer vers une équipe</DialogTitle>
            <DialogDescription>
              « {project?.name ?? ''} » rejoindra l’équipe choisie : ses membres y auront accès
              (administrateurs comme propriétaires, membres comme{' '}
              {TEAM_ROLE_LABELS.editor.toLowerCase()}s par défaut), et il comptera dans le stockage
              et les limites du plan de l’équipe. Vos invités gardent leur accès. Le projet ne
              pourra plus revenir dans votre workspace personnel.
            </DialogDescription>
          </DialogHeader>
          {error ? <Alert variant="destructive">{error}</Alert> : null}
          <div className="grid gap-2">
            <Label htmlFor="move-project-team">Équipe</Label>
            <NativeSelect
              id="move-project-team"
              name="team"
              className="h-9"
              defaultValue={teams[0]?.id}
              data-testid="move-project-team"
            >
              {teams.map((team) => (
                <option key={team.id} value={team.id}>
                  {team.name}
                </option>
              ))}
            </NativeSelect>
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                onOpenChange(false)
              }}
            >
              Annuler
            </Button>
            <Button type="submit" disabled={pending} data-testid="move-project-submit">
              Déplacer
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
