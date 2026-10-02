'use client'

import { ScrollArea as ScrollAreaPrimitive } from 'radix-ui'
import type * as React from 'react'
import { cn } from '../utils.js'

/**
 * Zone défilante aux barres discrètes, identiques sur tous les systèmes. `viewportRef` donne
 * l'élément qui défile (défilement programmé : chat, suivi de la sélection).
 */
export function ScrollArea({
  className,
  children,
  scrollbars = 'vertical',
  viewportRef,
  viewportClassName,
  ...props
}: React.ComponentProps<typeof ScrollAreaPrimitive.Root> & {
  scrollbars?: 'vertical' | 'horizontal' | 'both'
  viewportRef?: React.Ref<HTMLDivElement>
  viewportClassName?: string
}) {
  return (
    <ScrollAreaPrimitive.Root
      data-slot="scroll-area"
      className={cn('relative overflow-hidden', className)}
      {...props}
    >
      <ScrollAreaPrimitive.Viewport
        ref={viewportRef}
        data-slot="scroll-area-viewport"
        className={cn(
          // Radix pose `display: table` sur le contenu, ce qui empêche la troncature (`truncate`).
          'size-full rounded-[inherit] outline-none transition-[color,box-shadow] focus-visible:ring-[3px] focus-visible:ring-ring/50 [&>div]:block!',
          viewportClassName,
        )}
      >
        {children}
      </ScrollAreaPrimitive.Viewport>
      {scrollbars === 'horizontal' ? null : <ScrollBar orientation="vertical" />}
      {scrollbars === 'vertical' ? null : <ScrollBar orientation="horizontal" />}
      <ScrollAreaPrimitive.Corner />
    </ScrollAreaPrimitive.Root>
  )
}

export function ScrollBar({
  className,
  orientation = 'vertical',
  ...props
}: React.ComponentProps<typeof ScrollAreaPrimitive.ScrollAreaScrollbar>) {
  return (
    <ScrollAreaPrimitive.ScrollAreaScrollbar
      data-slot="scroll-area-scrollbar"
      orientation={orientation}
      className={cn(
        'flex touch-none select-none p-px transition-colors',
        orientation === 'vertical' && 'h-full w-2.5 border-l border-l-transparent',
        orientation === 'horizontal' && 'h-2.5 flex-col border-t border-t-transparent',
        className,
      )}
      {...props}
    >
      <ScrollAreaPrimitive.ScrollAreaThumb
        data-slot="scroll-area-thumb"
        className="relative flex-1 rounded-full bg-border hover:bg-muted-foreground/50"
      />
    </ScrollAreaPrimitive.ScrollAreaScrollbar>
  )
}
