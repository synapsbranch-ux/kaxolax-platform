import type * as React from 'react'
import { cn } from '../utils.js'

/**
 * Marque Kaxolax : un K sur un carré arrondi aux couleurs `primary`. `size` en pixels.
 * `title` est le nom lu par les lecteurs d'écran ; vide, le logo est décoratif (lien déjà nommé).
 */
export function Logo({
  size = 24,
  title = 'Kaxolax',
  className,
  ...props
}: Omit<React.ComponentProps<'svg'>, 'children' | 'width' | 'height'> & {
  size?: number
  title?: string
}) {
  const accessibility = title === '' ? { 'aria-hidden': true } : { role: 'img' }
  return (
    <svg
      data-slot="logo"
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 32 32"
      width={size}
      height={size}
      className={cn('shrink-0', className)}
      {...accessibility}
      {...props}
    >
      {title === '' ? null : <title>{title}</title>}
      <rect width="32" height="32" rx="8" className="fill-primary" />
      <path
        d="M11.5 8.5v15M21 8.5 13.75 16 21 23.5"
        fill="none"
        strokeWidth="3.2"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="stroke-primary-foreground"
      />
    </svg>
  )
}
