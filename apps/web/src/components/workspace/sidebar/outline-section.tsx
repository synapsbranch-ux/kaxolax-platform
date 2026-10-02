'use client'

import { Collapsible, CollapsibleContent, CollapsibleTrigger, cn } from '@kaxolax/ui'
import { ChevronRightIcon } from 'lucide-react'
import { type ReactNode, useState } from 'react'

/**
 * Section Outline repliable en bas de la sidebar : plan du document, section courante surlignée.
 * Le contenu (plan extrait par `extractOutline` de @kaxolax/editor) est fourni par `children`.
 */
export function OutlineSection({ children }: { children?: ReactNode }) {
  const [open, setOpen] = useState(true)
  return (
    <Collapsible
      open={open}
      onOpenChange={setOpen}
      className="flex max-h-[40%] min-h-0 shrink-0 flex-col border-t border-sidebar-border"
      data-testid="outline-section"
    >
      <CollapsibleTrigger className="flex h-8 shrink-0 items-center gap-1 px-3 text-xs font-semibold uppercase tracking-wide text-sidebar-muted-foreground outline-none hover:text-sidebar-foreground focus-visible:ring-[3px] focus-visible:ring-sidebar-ring/50">
        <ChevronRightIcon className={cn('size-3.5 transition-transform', open && 'rotate-90')} />
        Plan
      </CollapsibleTrigger>
      <CollapsibleContent className="min-h-0 overflow-auto px-2 pb-2">
        {children ?? (
          <p className="px-2 py-1 text-xs text-sidebar-muted-foreground">
            Le plan du document s'affichera ici.
          </p>
        )}
      </CollapsibleContent>
    </Collapsible>
  )
}
