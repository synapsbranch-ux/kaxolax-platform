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
import { SharePanel } from '@/components/sharing/share-panel'
import type { Project, User } from '@/lib/api'
import { shareDialogView } from '@/lib/sharing'

/**
 * Bouton d'invitation (personne +) de la sidebar et modale de partage (`SharePanel`) : gestion
 * complète pour le propriétaire, liste des membres et départ pour les autres rôles.
 */
export function ShareButton({
  project,
  user,
  membersVersion,
  onAccessChanged,
}: {
  project: Project | null
  user: User | null
  /** Incrémenté à chaque événement de membre : la modale ouverte relit la liste. */
  membersVersion: number
  /** Son propre rôle a changé depuis la modale (transfert de propriété). */
  onAccessChanged: () => void
}) {
  const [open, setOpen] = useState(false)
  const manage = project !== null && shareDialogView(project.role) === 'manage'
  const label = manage ? 'Partager le projet' : 'Membres du projet'
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <SimpleTooltip label={label}>
        <Button
          variant="ghost"
          size="icon-sm"
          className="shrink-0 text-sidebar-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
          aria-label={label}
          aria-haspopup="dialog"
          disabled={project === null || user === null}
          data-testid="share-button"
          onClick={() => {
            setOpen(true)
          }}
        >
          <UserPlusIcon />
        </Button>
      </SimpleTooltip>
      <DialogContent
        className="max-h-[90dvh] overflow-y-auto sm:max-w-xl"
        data-testid="share-dialog"
      >
        <DialogHeader>
          <DialogTitle className="truncate">Partager « {project?.name ?? ''} »</DialogTitle>
          <DialogDescription>
            {manage
              ? 'Invitez des collaborateurs par email ou partagez un lien. Éditeur : édite et compile ; relecteur : lit, compile et commente ; lecteur : lit et compile.'
              : 'Les membres du projet et leur rôle.'}
          </DialogDescription>
        </DialogHeader>
        {open && project && user ? (
          <SharePanel
            projectId={project.id}
            role={project.role}
            selfId={user.id}
            version={membersVersion}
            onAccessChanged={onAccessChanged}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  )
}
