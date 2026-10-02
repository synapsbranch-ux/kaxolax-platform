'use client'

import { cva, type VariantProps } from 'class-variance-authority'
import { XIcon } from 'lucide-react'
import { Dialog as SheetPrimitive } from 'radix-ui'
import type * as React from 'react'
import { cn } from '../utils.js'

/** Tiroir : panneau qui glisse depuis un bord (historique, journaux de compilation, menus mobiles). */
export const Sheet = SheetPrimitive.Root
export const SheetTrigger = SheetPrimitive.Trigger
export const SheetClose = SheetPrimitive.Close

export const sheetVariants = cva('z-50 flex flex-col gap-4 bg-background shadow-lg', {
  variants: {
    side: {
      right: 'inset-y-0 right-0 h-full w-3/4 border-l sm:max-w-sm',
      left: 'inset-y-0 left-0 h-full w-3/4 border-r sm:max-w-sm',
      top: 'inset-x-0 top-0 h-auto max-h-[80%] border-b',
      bottom: 'inset-x-0 bottom-0 h-auto max-h-[80%] border-t',
    },
  },
  defaultVariants: { side: 'right' },
})

export function SheetContent({
  className,
  children,
  side,
  container,
  showOverlay = true,
  showCloseButton = true,
  closeLabel = 'Fermer',
  ...props
}: React.ComponentProps<typeof SheetPrimitive.Content> &
  VariantProps<typeof sheetVariants> & {
    /**
     * Élément qui accueille le tiroir (par défaut <body>). Le tiroir se place alors en position
     * absolue dans cet élément, qui doit être `relative` : tiroir des journaux au-dessus du PDF.
     */
    container?: React.ComponentProps<typeof SheetPrimitive.Portal>['container']
    /** Voile derrière le tiroir (ignoré si la racine `Sheet` a `modal={false}`). */
    showOverlay?: boolean
    showCloseButton?: boolean
    closeLabel?: string
  }) {
  const position = container ? 'absolute' : 'fixed'
  return (
    <SheetPrimitive.Portal container={container}>
      {showOverlay ? (
        <SheetPrimitive.Overlay
          data-slot="sheet-overlay"
          className={cn(position, 'inset-0 z-50 bg-black/50')}
        />
      ) : null}
      <SheetPrimitive.Content
        data-slot="sheet-content"
        className={cn(position, sheetVariants({ side }), className)}
        {...props}
      >
        {children}
        {showCloseButton ? (
          <SheetPrimitive.Close className="absolute right-4 top-4 rounded-xs opacity-70 outline-none transition-opacity hover:opacity-100 focus-visible:opacity-100 focus-visible:ring-[3px] focus-visible:ring-ring/50">
            <XIcon className="size-4" />
            <span className="sr-only">{closeLabel}</span>
          </SheetPrimitive.Close>
        ) : null}
      </SheetPrimitive.Content>
    </SheetPrimitive.Portal>
  )
}

export function SheetHeader({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="sheet-header"
      className={cn('flex flex-col gap-1.5 p-4', className)}
      {...props}
    />
  )
}

export function SheetFooter({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="sheet-footer"
      className={cn('mt-auto flex flex-col gap-2 p-4', className)}
      {...props}
    />
  )
}

export function SheetTitle({
  className,
  ...props
}: React.ComponentProps<typeof SheetPrimitive.Title>) {
  return (
    <SheetPrimitive.Title
      data-slot="sheet-title"
      className={cn('font-semibold text-foreground', className)}
      {...props}
    />
  )
}

export function SheetDescription({
  className,
  ...props
}: React.ComponentProps<typeof SheetPrimitive.Description>) {
  return (
    <SheetPrimitive.Description
      data-slot="sheet-description"
      className={cn('text-sm text-muted-foreground', className)}
      {...props}
    />
  )
}
