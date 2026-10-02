'use client'

import { Tooltip as TooltipPrimitive } from 'radix-ui'
import type * as React from 'react'
import { cn } from '../utils.js'
import { KbdShortcut } from './kbd.js'

/**
 * À placer une fois autour de l'application : les infobulles voisines s'enchaînent sans
 * nouveau délai. Obligatoire pour `Tooltip` et `SimpleTooltip`.
 */
export function TooltipProvider({
  delayDuration = 300,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Provider>) {
  return <TooltipPrimitive.Provider delayDuration={delayDuration} {...props} />
}

export const Tooltip = TooltipPrimitive.Root
export const TooltipTrigger = TooltipPrimitive.Trigger

export function TooltipContent({
  className,
  sideOffset = 4,
  children,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Content>) {
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Content
        data-slot="tooltip-content"
        sideOffset={sideOffset}
        className={cn(
          'z-50 flex w-fit max-w-xs items-center gap-2 text-balance rounded-md bg-foreground px-2.5 py-1.5 text-xs text-background origin-(--radix-tooltip-content-transform-origin)',
          className,
        )}
        {...props}
      >
        {children}
        <TooltipPrimitive.Arrow className="z-50 size-2.5 translate-y-[calc(-50%_-_2px)] rotate-45 rounded-[2px] bg-foreground fill-foreground" />
      </TooltipPrimitive.Content>
    </TooltipPrimitive.Portal>
  )
}

/**
 * Infobulle d'un contrôle, souvent un bouton icône : libellé et raccourci éventuel (format
 * CodeMirror, `Mod-Enter`). L'enfant doit accepter une ref (Button, élément DOM).
 */
export function SimpleTooltip({
  label,
  shortcut,
  side,
  align,
  children,
}: {
  label: React.ReactNode
  shortcut?: string
  side?: React.ComponentProps<typeof TooltipPrimitive.Content>['side']
  align?: React.ComponentProps<typeof TooltipPrimitive.Content>['align']
  children: React.ReactElement
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side={side} align={align}>
        <span>{label}</span>
        {shortcut === undefined ? null : <KbdShortcut shortcut={shortcut} />}
      </TooltipContent>
    </Tooltip>
  )
}
