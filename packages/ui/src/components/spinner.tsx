import { Loader2Icon } from 'lucide-react'
import type * as React from 'react'
import { cn } from '../utils.js'

/**
 * Indicateur d'activité (role="status"). `label` est lu par les lecteurs d'écran ; vide, le
 * spinner est décoratif (le texte voisin dit déjà ce qui se passe).
 */
export function Spinner({
  className,
  label = 'Chargement',
  ...props
}: Omit<React.ComponentProps<'svg'>, 'children'> & { label?: string }) {
  const accessibility =
    label === '' ? { 'aria-hidden': true } : { role: 'status', 'aria-label': label }
  return (
    <Loader2Icon
      data-slot="spinner"
      className={cn(
        'size-4 animate-spin motion-reduce:animate-[spin_1.5s_linear_infinite]',
        className,
      )}
      {...accessibility}
      {...props}
    />
  )
}
