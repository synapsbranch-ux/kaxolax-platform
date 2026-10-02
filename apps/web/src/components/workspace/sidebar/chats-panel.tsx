import { MessagesSquareIcon } from 'lucide-react'

/**
 * Onglet Chats de la sidebar. Emplacement de la tâche 6 (chat du projet entre collaborateurs) ;
 * les conversations avec l'assistant s'y ajouteront à l'étape 3.
 */
export function ChatsPanel() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center text-sidebar-muted-foreground">
      <MessagesSquareIcon className="size-6" />
      <p className="text-sm">Le chat du projet arrive bientôt.</p>
    </div>
  )
}
