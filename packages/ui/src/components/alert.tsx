import { cva, type VariantProps } from 'class-variance-authority'
import type * as React from 'react'
import { cn } from '../utils.js'

const alertVariants = cva('relative w-full rounded-lg border px-4 py-3 text-sm', {
  variants: {
    variant: {
      default: 'bg-card text-card-foreground',
      destructive: 'border-destructive/50 bg-card text-destructive',
      success: 'border-success/40 bg-card text-success',
      warning: 'border-warning/50 bg-card text-card-foreground',
    },
  },
  defaultVariants: { variant: 'default' },
})

export function Alert({
  className,
  variant,
  ...props
}: React.ComponentProps<'div'> & VariantProps<typeof alertVariants>) {
  return (
    <div
      data-slot="alert"
      role="alert"
      className={cn(alertVariants({ variant }), className)}
      {...props}
    />
  )
}
