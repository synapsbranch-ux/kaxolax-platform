'use client'

import { Button, SimpleTooltip, cn } from '@kaxolax/ui'
import { MoonIcon, SunIcon } from 'lucide-react'
import { usePreferences } from './preferences-provider'

/**
 * Bascule entre thème sombre et clair (sidebar et éditeur ; la zone PDF reste claire). Préférence
 * de l'utilisateur, appliquée sur tous ses appareils ; les paramètres complets de l'éditeur
 * (tâche 10) reprendront ce réglage.
 */
export function ThemeToggle({ className }: { className?: string }) {
  const { preferences, update } = usePreferences()
  const dark = preferences.theme === 'dark'
  const label = dark ? 'Passer au thème clair' : 'Passer au thème sombre'
  return (
    <SimpleTooltip label={label}>
      <Button
        variant="ghost"
        size="icon-sm"
        className={cn(
          'shrink-0 text-sidebar-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground',
          className,
        )}
        aria-label={label}
        data-testid="theme-toggle"
        onClick={() => {
          update({ theme: dark ? 'light' : 'dark' })
        }}
      >
        {dark ? <SunIcon /> : <MoonIcon />}
      </Button>
    </SimpleTooltip>
  )
}
