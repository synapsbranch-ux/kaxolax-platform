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

export function ResizableHandle({ className, ...props }: React.ComponentProps<typeof Separator>) {
  return (
    <Separator
      data-slot="resizable-handle"
      className={cn(
        'relative flex w-px items-center justify-center bg-border after:absolute after:inset-y-0 after:left-1/2 after:w-2 after:-translate-x-1/2 focus-visible:outline-hidden',
        className,
      )}
      {...props}
    >
      <div className="z-10 flex h-4 w-3 items-center justify-center rounded-xs border bg-border">
        <GripVerticalIcon className="size-2.5" />
      </div>
    </Separator>
  )
}
