'use client'

import type { CompileResult, LogEntry } from '@kaxolax/contracts'
import { Badge, Button, cn } from '@kaxolax/ui'
import { useEffect, useState } from 'react'
import { groupEntries, locationLabel } from '@/lib/logs'

const LEVELS = [
  { key: 'errors', label: 'Erreurs', tone: 'border-l-destructive' },
  { key: 'warnings', label: 'Avertissements', tone: 'border-l-amber-500' },
  { key: 'typesetting', label: 'Mise en page', tone: 'border-l-sky-500' },
] as const

export function LogPanel({
  result,
  onOpenLocation,
  onClearCache,
}: {
  result: CompileResult | null
  onOpenLocation: (file: string, line: number) => void
  onClearCache: () => Promise<void>
}) {
  // Log brut chargé à la demande, gardé avec l'URL dont il vient.
  const [raw, setRaw] = useState<{ url: string; text: string } | null>(null)
  const [showRaw, setShowRaw] = useState(false)
  const [clearing, setClearing] = useState(false)
  const logUrl = result?.logUrl ?? null
  const rawText = raw !== null && raw.url === logUrl ? raw.text : null

  useEffect(() => {
    if (!showRaw || logUrl === null) return
    let active = true
    void fetch(logUrl)
      .then((response) => response.text())
      .then((text) => {
        if (active) setRaw({ url: logUrl, text })
      })
    return () => {
      active = false
    }
  }, [showRaw, logUrl])

  if (result === null) {
    return <p className="p-4 text-sm text-muted-foreground">Aucune compilation pour l'instant.</p>
  }
  const grouped = groupEntries(result.entries)

  const entry = (item: LogEntry, index: number, tone: string) => {
    const location = locationLabel(item)
    const clickable = item.file !== null && item.line !== null
    return (
      <button
        key={index}
        type="button"
        disabled={!clickable}
        data-testid={`log-${item.level}`}
        onClick={() => {
          if (item.file !== null && item.line !== null) onOpenLocation(item.file, item.line)
        }}
        className={cn(
          'block w-full rounded border border-l-4 bg-background px-3 py-2 text-left text-sm',
          tone,
          clickable ? 'hover:bg-accent' : 'cursor-default',
        )}
      >
        <span className="font-medium">{item.message}</span>
        {location ? (
          <span className="ml-2 font-mono text-xs text-muted-foreground">{location}</span>
        ) : null}
      </button>
    )
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b px-3">
        <Badge
          variant={result.status === 'success' ? 'secondary' : 'destructive'}
          data-testid="compile-status"
        >
          {result.status}
        </Badge>
        <span className="text-xs text-muted-foreground">
          {(result.durationMs / 1000).toFixed(1)} s
        </span>
        <Button
          variant="ghost"
          size="sm"
          className="ml-auto"
          onClick={() => {
            setShowRaw((value) => !value)
          }}
          disabled={logUrl === null}
        >
          {showRaw ? 'Entrées' : 'Log brut'}
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={clearing}
          onClick={() => {
            setClearing(true)
            void onClearCache().finally(() => {
              setClearing(false)
            })
          }}
        >
          Vider le cache
        </Button>
      </div>
      <div className="flex-1 overflow-auto p-3">
        {showRaw ? (
          <pre className="whitespace-pre-wrap break-all font-mono text-xs" data-testid="raw-log">
            {rawText ?? 'Chargement…'}
          </pre>
        ) : (
          <div className="grid gap-4">
            {LEVELS.map((level) =>
              grouped[level.key].length > 0 ? (
                <section key={level.key} className="grid gap-2">
                  <h3 className="text-xs font-semibold uppercase text-muted-foreground">
                    {level.label} ({grouped[level.key].length})
                  </h3>
                  {grouped[level.key].map((item, index) => entry(item, index, level.tone))}
                </section>
              ) : null,
            )}
            {result.entries.length === 0 ? (
              <p className="text-sm text-muted-foreground">Aucun message.</p>
            ) : null}
          </div>
        )}
      </div>
    </div>
  )
}
