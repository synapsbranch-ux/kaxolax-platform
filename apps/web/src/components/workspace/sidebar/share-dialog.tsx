'use client'

import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  SimpleTooltip,
} from '@kaxolax/ui'
import { UserPlusIcon } from 'lucide-react'
import { useState } from 'react'
import type { Project } from '@/lib/api'

/**
 * Bouton d'invitation (personne +) et modale de partage. Emplacement de la tâche 4 (partage) :
 * invitations par email, rôles, liens de partage et transfert de propriété y prendront place.
 */
export function ShareButton({ project }: { project: Project | null }) {
  const [open, setOpen] = useState(false)
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <SimpleTooltip label="Partager le projet">
        <Button
          variant="ghost"
          size="icon-sm"
          className="shrink-0 text-sidebar-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
          aria-label="Partager le projet"
          data-testid="share-button"
          onClick={() => {
            setOpen(true)
          }}
        >
          <UserPlusIcon />
        </Button>
      </SimpleTooltip>
      <DialogContent data-testid="share-dialog">
        <DialogHeader>
          <DialogTitle>Partager « {project?.name ?? ''} »</DialogTitle>
          <DialogDescription>
            L'invitation par email, les rôles (éditeur, relecteur, lecteur) et les liens de partage
            arrivent bientôt.
          </DialogDescription>
        </DialogHeader>
      </DialogContent>
    </Dialog>
  )
}
