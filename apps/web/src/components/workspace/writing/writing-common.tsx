'use client'

import type { ActionContext } from '@kaxolax/editor'
import { Button } from '@kaxolax/ui'
import { PackageIcon } from 'lucide-react'
import type { PackageCheck } from '@/lib/writing'

/** Liste `amsmath, amssymb` en code. */
function Names({ names }: { names: readonly string[] }) {
  return names.map((name, index) => (
    <span key={name}>
      {index > 0 ? ', ' : null}
      <code className="font-mono">{name}</code>
    </span>
  ))
}

/**
 * État des packages demandés par un outil : ajoutés automatiquement à l'insertion (`automatic`),
 * proposés en un clic (`onAdd`), ou à charger dans le document principal (fichier sans préambule).
 */
export function PackageNote({
  check,
  automatic = false,
  onAdd,
}: {
  check: PackageCheck
  automatic?: boolean
  onAdd?: (names: string[]) => void
}) {
  if (check.kind === 'ok') return null
  if (check.kind === 'no-preamble') {
    return (
      <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
        <PackageIcon className="mt-0.5 size-3.5 shrink-0" aria-hidden />
        <span>
          Ce fichier n’a pas de préambule : vérifiez que le document principal charge{' '}
          <Names names={check.names} />.
        </span>
      </p>
    )
  }
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
      <PackageIcon className="size-3.5 shrink-0" aria-hidden />
      <span>
        {check.names.length > 1 ? 'Packages absents' : 'Package absent'} du préambule :{' '}
        <Names names={check.names} />
        {automatic ? ' (ajouté à l’insertion).' : '.'}
      </span>
      {onAdd ? (
        <Button
          size="xs"
          variant="outline"
          onClick={() => {
            onAdd(check.names)
          }}
        >
          Ajouter au préambule
        </Button>
      ) : null}
    </div>
  )
}

/** À la fermeture d'une boîte de dialogue d'outil : le focus revient dans l'éditeur. */
export function focusEditorOnClose(event: Event, context: () => ActionContext): void {
  const view = context().view
  if (view === null) return
  event.preventDefault()
  view.focus()
}
