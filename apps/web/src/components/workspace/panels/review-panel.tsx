'use client'

import { Button } from '@kaxolax/ui'
import { MessageSquareTextIcon, XIcon } from 'lucide-react'

/**
 * Panneau Review, à droite de l'éditeur. Emplacement de la tâche 7 (commentaires ancrés, fils de
 * discussion, résolution, navigation d'un commentaire au suivant) : la mise en page est posée,
 * le contenu arrive avec elle.
 */
export function ReviewPanel({ onClose }: { onClose: () => void }) {
  return (
    <aside
      aria-label="Review"
      className="flex w-72 shrink-0 flex-col border-l border-editor-border bg-editor-toolbar text-editor-toolbar-foreground"
      data-testid="review-panel"
    >
      <div className="flex h-tab shrink-0 items-center justify-between border-b border-editor-border px-3 text-sm font-medium">
        Review
        <Button
          variant="ghost"
          size="icon-xs"
          className="hover:bg-editor-tab-active"
          aria-label="Fermer le panneau Review"
          onClick={onClose}
        >
          <XIcon />
        </Button>
      </div>
      <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center text-editor-gutter-foreground">
        <MessageSquareTextIcon className="size-6" />
        <p className="text-sm">Les commentaires du projet arrivent bientôt.</p>
      </div>
    </aside>
  )
}
