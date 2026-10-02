'use client'

import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@kaxolax/ui'
import { HistoryIcon } from 'lucide-react'

/**
 * Tiroir Historique (versions du projet). Emplacement de la tâche 8 (versions groupées par jour,
 * diff par fichier, labels, restauration, téléchargement d'une version) : le tiroir et son
 * ouverture sont posés, le contenu arrive avec elle.
 */
export function HistoryDrawer({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-96 max-w-[90vw]" data-testid="history-drawer">
        <SheetHeader>
          <SheetTitle>Historique</SheetTitle>
          <SheetDescription>Versions du projet, comparaison et restauration.</SheetDescription>
        </SheetHeader>
        <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center text-muted-foreground">
          <HistoryIcon className="size-6" />
          <p className="text-sm">L'historique des versions arrive bientôt.</p>
        </div>
      </SheetContent>
    </Sheet>
  )
}
