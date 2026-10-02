'use client'

import { GripVerticalIcon } from 'lucide-react'
import type * as React from 'react'
import { Group, Panel, Separator } from 'react-resizable-panels'
import { cn } from '../utils.js'

export function ResizablePanelGroup({ className, ...props }: React.ComponentProps<typeof Group>) {
  return (
    <Group
      data-slot="resizable-panel-group"
      className={cn('flex h-full w-full', className)}
      {...props}
    />
  )
}

export const ResizablePanel = Panel

/** API impérative d'un groupe (`groupRef` : getLayout, setLayout) et d'un panneau (`panelRef`). */
export type {
  GroupImperativeHandle as ResizableGroupHandle,
  PanelImperativeHandle as ResizablePanelHandle,
} from 'react-resizable-panels'

/** Poignée entre deux panneaux ; `withHandle={false}` n'affiche qu'un filet (zone de saisie inchangée). */
export function ResizableHandle({
  className,
  withHandle = true,
  ...props
}: React.ComponentProps<typeof Separator> & { withHandle?: boolean }) {
  return (
    <Separator
      data-slot="resizable-handle"
      className={cn(
        'relative flex w-px items-center justify-center bg-border after:absolute after:inset-y-0 after:left-1/2 after:w-2 after:-translate-x-1/2 focus-visible:outline-hidden focus-visible:ring-[3px] focus-visible:ring-ring/50',
        className,
      )}
      {...props}
    >
      {withHandle ? (
        <div className="z-10 flex h-4 w-3 items-center justify-center rounded-xs border bg-border">
          <GripVerticalIcon className="size-2.5" />
        </div>
      ) : null}
    </Separator>
  )
}
