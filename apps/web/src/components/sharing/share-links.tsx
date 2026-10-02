'use client'

import type { ShareLinkKind, ShareLinkState } from '@kaxolax/contracts'
import { Button, Input, Label, Switch } from '@kaxolax/ui'
import { CopyIcon, RefreshCwIcon } from 'lucide-react'
import { SHARE_LINK_LABELS } from '@/lib/sharing'

/**
 * Liens de partage du projet (propriétaire) : lecture seule et édition, chacun activable,
 * désactivable (désactiver puis réactiver redonne le même lien), régénérable après confirmation
 * (l'ancien lien cesse de fonctionner) et copiable.
 */
export function ShareLinks({
  links,
  busy,
  onToggle,
  onRegenerate,
  onCopied,
  onError,
}: {
  links: readonly ShareLinkState[]
  busy: string | null
  onToggle: (kind: ShareLinkKind, enabled: boolean) => void
  /** Demande de régénération (la modale demande confirmation). */
  onRegenerate: (kind: ShareLinkKind) => void
  onCopied: (message: string) => void
  onError: (error: unknown) => void
}) {
  return (
    <section aria-labelledby="share-links-title" className="flex flex-col gap-3">
      <h3 id="share-links-title" className="text-sm font-medium">
        Liens de partage
      </h3>
      {links.map((link) => {
        const labels = SHARE_LINK_LABELS[link.kind]
        const switchId = `share-link-${link.kind}`
        const disabled = busy !== null
        return (
          <div
            key={link.kind}
            className="flex flex-col gap-2"
            data-testid={`share-link-${link.kind}`}
          >
            <div className="flex items-start gap-3">
              <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                <Label htmlFor={switchId}>{labels.title}</Label>
                <p className="text-xs text-muted-foreground">{labels.description}</p>
              </div>
              <Switch
                id={switchId}
                checked={link.enabled}
                disabled={disabled}
                onCheckedChange={(checked) => {
                  onToggle(link.kind, checked)
                }}
                data-testid="share-link-toggle"
              />
            </div>
            {link.enabled && link.url !== null ? (
              <div className="flex flex-col gap-2 sm:flex-row">
                <Input
                  readOnly
                  value={link.url}
                  aria-label={labels.title}
                  className="font-mono text-xs sm:flex-1"
                  onFocus={(event) => {
                    event.currentTarget.select()
                  }}
                  data-testid="share-link-url"
                />
                <div className="flex gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      const url = link.url ?? ''
                      navigator.clipboard.writeText(url).then(() => {
                        onCopied(`${labels.title} copié.`)
                      }, onError)
                    }}
                    data-testid="share-link-copy"
                  >
                    <CopyIcon /> Copier
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={disabled}
                    onClick={() => {
                      onRegenerate(link.kind)
                    }}
                    data-testid="share-link-regenerate"
                  >
                    <RefreshCwIcon /> Régénérer
                  </Button>
                </div>
              </div>
            ) : null}
          </div>
        )
      })}
    </section>
  )
}
