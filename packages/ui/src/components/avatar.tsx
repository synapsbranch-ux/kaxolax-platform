'use client'

import { cva, type VariantProps } from 'class-variance-authority'
import { Avatar as AvatarPrimitive } from 'radix-ui'
import type * as React from 'react'
import { cn } from '../utils.js'

export const avatarVariants = cva(
  'relative flex shrink-0 select-none overflow-hidden rounded-full',
  {
    variants: {
      size: {
        xs: 'size-5 text-[0.5625rem]',
        sm: 'size-6 text-[0.625rem]',
        default: 'size-8 text-xs',
        lg: 'size-10 text-sm',
      },
    },
    defaultVariants: { size: 'default' },
  },
)

export type AvatarSize = NonNullable<VariantProps<typeof avatarVariants>['size']>

export function Avatar({
  className,
  size,
  ...props
}: React.ComponentProps<typeof AvatarPrimitive.Root> & VariantProps<typeof avatarVariants>) {
  return (
    <AvatarPrimitive.Root
      data-slot="avatar"
      className={cn(avatarVariants({ size }), className)}
      {...props}
    />
  )
}

export function AvatarImage({
  className,
  ...props
}: React.ComponentProps<typeof AvatarPrimitive.Image>) {
  return (
    <AvatarPrimitive.Image
      data-slot="avatar-image"
      className={cn('aspect-square size-full object-cover', className)}
      {...props}
    />
  )
}

/** Affiché tant que l'image n'est pas chargée, ou à sa place (initiales). */
export function AvatarFallback({
  className,
  ...props
}: React.ComponentProps<typeof AvatarPrimitive.Fallback>) {
  return (
    <AvatarPrimitive.Fallback
      data-slot="avatar-fallback"
      className={cn(
        'flex size-full items-center justify-center rounded-full bg-muted font-medium text-muted-foreground',
        className,
      )}
      {...props}
    />
  )
}
