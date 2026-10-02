'use client'

import type * as React from 'react'
import { useSyncExternalStore } from 'react'
import { formatShortcut, formatShortcutText, isMacPlatform } from '../lib/shortcut.js'
import { cn } from '../utils.js'

function subscribeNothing() {
  return () => {
    // La plateforme ne change pas pendant la vie de la page.
  }
}

/**
 * Vrai sur Mac (⌘ au lieu de Ctrl). Faux au rendu serveur puis corrigé à l'hydratation,
 * sans écart d'hydratation.
 */
export function useIsMac(): boolean {
  return useSyncExternalStore(subscribeNothing, isMacPlatform, () => false)
}

/** Raccourci au format CodeMirror (`Mod-Shift-k`) mis en texte pour la plateforme courante. */
export function useShortcutText(shortcut: string | undefined): string | undefined {
  const mac = useIsMac()
  return shortcut === undefined ? undefined : formatShortcutText(shortcut, mac)
}

export function Kbd({ className, ...props }: React.ComponentProps<'kbd'>) {
  return (
    <kbd
      data-slot="kbd"
      className={cn(
        "pointer-events-none inline-flex h-5 w-fit min-w-5 select-none items-center justify-center gap-1 rounded-sm bg-muted px-1 font-sans text-xs font-medium text-muted-foreground [&_svg:not([class*='size-'])]:size-3",
        '[[data-slot=tooltip-content]_&]:bg-background/20 [[data-slot=tooltip-content]_&]:text-background',
        className,
      )}
      {...props}
    />
  )
}

export function KbdGroup({ className, ...props }: React.ComponentProps<'kbd'>) {
  return (
    <kbd
      data-slot="kbd-group"
      className={cn('inline-flex items-center gap-1', className)}
      {...props}
    />
  )
}

/** Raccourci au format CodeMirror affiché touche par touche (`Mod-Enter` → ⌘ ↩ ou Ctrl Entrée). */
export function KbdShortcut({
  shortcut,
  className,
  ...props
}: Omit<React.ComponentProps<'kbd'>, 'children'> & { shortcut: string }) {
  const mac = useIsMac()
  return (
    <KbdGroup className={className} {...props}>
      {formatShortcut(shortcut, mac).map((key, index) => (
        <Kbd key={`${String(index)}-${key}`}>{key}</Kbd>
      ))}
    </KbdGroup>
  )
}
