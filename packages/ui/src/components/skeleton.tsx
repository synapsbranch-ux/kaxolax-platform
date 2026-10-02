import type * as React from 'react'
import { cn } from '../utils.js'

/** Bloc gris animé à la place d'un contenu en cours de chargement (ignoré des lecteurs d'écran). */
export function Skeleton({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="skeleton"
      aria-hidden
      className={cn('animate-pulse rounded-md bg-muted motion-reduce:animate-none', className)}
      {...props}
    />
  )
}
