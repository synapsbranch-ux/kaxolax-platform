'use client'

import { Label as LabelPrimitive } from 'radix-ui'
import type * as React from 'react'
import { cn } from '../utils.js'

export function Label({ className, ...props }: React.ComponentProps<typeof LabelPrimitive.Root>) {
  return (
    <LabelPrimitive.Root
      data-slot="label"
      className={cn(
        'flex select-none items-center gap-2 text-sm font-medium leading-none',
        className,
      )}
      {...props}
    />
  )
}
