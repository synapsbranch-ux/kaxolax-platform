'use client'

import { type VariantProps } from 'class-variance-authority'
import { ToggleGroup as ToggleGroupPrimitive } from 'radix-ui'
import type * as React from 'react'
import { createContext, useContext } from 'react'
import { cn } from '../utils.js'
import { toggleVariants } from './toggle.js'

type ToggleVariants = VariantProps<typeof toggleVariants>

const ToggleGroupContext = createContext<ToggleVariants>({ variant: 'default', size: 'default' })

/**
 * Groupe de boutons à état, choix unique (`type="single"`, ex. alignement) ou multiple
 * (`type="multiple"`). Les éléments héritent de la variante et de la taille du groupe.
 */
export function ToggleGroup({
  className,
  variant,
  size,
  children,
  ...props
}: React.ComponentProps<typeof ToggleGroupPrimitive.Root> & ToggleVariants) {
  return (
    <ToggleGroupPrimitive.Root
      data-slot="toggle-group"
      data-variant={variant ?? 'default'}
      data-size={size ?? 'default'}
      className={cn(
        'group/toggle-group flex w-fit items-center rounded-md data-[variant=outline]:shadow-xs',
        className,
      )}
      {...props}
    >
      <ToggleGroupContext value={{ variant, size }}>{children}</ToggleGroupContext>
    </ToggleGroupPrimitive.Root>
  )
}

export function ToggleGroupItem({
  className,
  variant,
  size,
  ...props
}: React.ComponentProps<typeof ToggleGroupPrimitive.Item> & ToggleVariants) {
  const context = useContext(ToggleGroupContext)
  const resolvedVariant = context.variant ?? variant
  const resolvedSize = context.size ?? size
  return (
    <ToggleGroupPrimitive.Item
      data-slot="toggle-group-item"
      data-variant={resolvedVariant ?? 'default'}
      data-size={resolvedSize ?? 'default'}
      className={cn(
        toggleVariants({ variant: resolvedVariant, size: resolvedSize }),
        'min-w-0 flex-1 shrink-0 rounded-none shadow-none first:rounded-l-md last:rounded-r-md focus:z-10 focus-visible:z-10 data-[variant=outline]:border-l-0 data-[variant=outline]:first:border-l',
        className,
      )}
      {...props}
    />
  )
}
