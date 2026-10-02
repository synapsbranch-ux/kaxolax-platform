import { SparklesIcon } from 'lucide-react'

/**
 * Zone « Ask anything » en bas de l'éditeur : sa place est réservée dans la mise en page,
 * l'assistant arrive à l'étape 3.
 */
export function AskSlot() {
  return (
    <div className="flex h-ask shrink-0 items-center border-t border-editor-border bg-editor px-3">
      <div
        aria-disabled
        title="L'assistant arrive à l'étape 3"
        className="flex h-9 w-full cursor-not-allowed items-center gap-2 rounded-lg border border-editor-border bg-editor-tabbar px-3 text-sm text-editor-gutter-foreground"
        data-testid="ask-slot"
      >
        <SparklesIcon className="size-4" />
        Demander à l'assistant… (bientôt)
      </div>
    </div>
  )
}
