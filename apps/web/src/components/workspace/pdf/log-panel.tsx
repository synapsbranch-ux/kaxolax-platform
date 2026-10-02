'use client'

import type { CompileResult, LogEntry, PackageSuggestions } from '@kaxolax/contracts'
import { Badge, Button, Spinner, cn } from '@kaxolax/ui'
import { WandSparklesIcon, XIcon } from 'lucide-react'
import { useEffect, useState } from 'react'
import { api } from '@/lib/api'
import { groupEntries, locationLabel } from '@/lib/logs'
import {
  type MissingPackage,
  missingPackageOf,
  suggestionLabel,
  texliveErrorMessage,
} from '@/lib/package-tools'

/**
 * Remplace, dans le document de l'entrée du log (sinon le document principal), le package ou la
 * classe introuvable par `replacement`. Résolu à faux si la commande n'a pas été trouvée.
 */
export type FixPackage = (
  entry: LogEntry,
  missing: MissingPackage,
  replacement: string,
) => Promise<boolean>

/** Suggestions déjà demandées (même fichier introuvable : même réponse pendant la session). */
const suggestionCache = new Map<string, Promise<PackageSuggestions>>()

function suggestionsFor(file: string): Promise<PackageSuggestions> {
  let pending = suggestionCache.get(file)
  if (!pending) {
    pending = api.packageSuggestions(file)
    suggestionCache.set(file, pending)
    // Un échec (réseau, index indisponible) n'est pas mémorisé.
    pending.catch(() => suggestionCache.delete(file))
  }
  return pending
}

/**
 * Sous une erreur « File `xyz.sty' not found » : packages (ou classes) de TeX Live aux noms les
 * plus proches, et un bouton qui corrige le `\usepackage` (ou `\documentclass`) en un clic.
 */
function MissingPackageHint({
  entry,
  missing,
  onFix,
}: {
  entry: LogEntry
  missing: MissingPackage
  onFix?: FixPackage
}) {
  const [state, setState] = useState<
    { file: string; result: PackageSuggestions } | { file: string; error: string } | null
  >(null)
  const [fixing, setFixing] = useState<string | null>(null)
  const [outcome, setOutcome] = useState<string | null>(null)

  useEffect(() => {
    let active = true
    suggestionsFor(missing.file).then(
      (result) => {
        if (active) setState({ file: missing.file, result })
      },
      (caught: unknown) => {
        if (active) setState({ file: missing.file, error: texliveErrorMessage(caught) })
      },
    )
    return () => {
      active = false
    }
  }, [missing.file])

  const current = state?.file === missing.file ? state : null
  const what = missing.kind === 'class' ? 'classe' : 'package'
  return (
    <div
      className="mt-1 grid gap-1.5 rounded border border-dashed bg-muted/40 px-3 py-2 text-xs"
      data-testid="missing-package"
    >
      {current === null ? (
        <p className="flex items-center gap-2 text-muted-foreground">
          <Spinner label="" /> Recherche des noms proches…
        </p>
      ) : 'error' in current ? (
        <p className="text-muted-foreground">{current.error}</p>
      ) : current.result.exists ? (
        <p className="text-muted-foreground">
          <code>{missing.file}</code> existe dans TeX Live mais pas dans l’image de compilation, ou
          son nom est écrit avec une autre casse.
        </p>
      ) : current.result.suggestions.length === 0 ? (
        <p className="text-muted-foreground">
          Aucune {what} de TeX Live ne porte un nom proche de <code>{missing.name}</code>.
        </p>
      ) : (
        <>
          <p className="text-muted-foreground">
            {current.result.suggestions.length > 1
              ? `Noms de ${what}s proches :`
              : `Nom de ${what} proche :`}
          </p>
          <ul className="flex flex-wrap gap-1.5" aria-label="Suggestions">
            {current.result.suggestions.map((suggestion) => (
              <li key={suggestion.file}>
                {onFix ? (
                  <Button
                    size="xs"
                    variant="outline"
                    disabled={fixing !== null}
                    title={suggestion.shortdesc ?? undefined}
                    aria-label={`Remplacer ${missing.name} par ${suggestion.name}`}
                    onClick={() => {
                      setFixing(suggestion.name)
                      setOutcome(null)
                      onFix(entry, missing, suggestion.name).then(
                        (done) => {
                          setFixing(null)
                          setOutcome(
                            done
                              ? `${missing.name} remplacé par ${suggestion.name}. Recompilez pour vérifier.`
                              : `${missing.name} introuvable dans les commandes du document : corrigez-le à la main.`,
                          )
                        },
                        () => {
                          setFixing(null)
                        },
                      )
                    }}
                    data-testid="fix-package"
                  >
                    {fixing === suggestion.name ? <Spinner label="" /> : <WandSparklesIcon />}
                    {suggestionLabel(suggestion)}
                  </Button>
                ) : (
                  <code title={suggestion.shortdesc ?? undefined}>
                    {suggestionLabel(suggestion)}
                  </code>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
      {outcome ? (
        <p role="status" className="text-muted-foreground">
          {outcome}
        </p>
      ) : null}
    </div>
  )
}

const STATUS_LABELS: Record<CompileResult['status'], string> = {
  success: 'Réussie',
  failure: 'Échec',
  timeout: 'Délai dépassé',
  error: 'Erreur',
}

const LEVELS = [
  { key: 'errors', label: 'Erreurs', tone: 'border-l-destructive' },
  { key: 'warnings', label: 'Avertissements', tone: 'border-l-warning' },
  { key: 'typesetting', label: 'Mise en page', tone: 'border-l-tools' },
] as const

/**
 * Journaux de la dernière compilation, dans un tiroir au-dessus du PDF : entrées groupées par
 * niveau et cliquables (fichier et ligne), log brut, vidage du cache.
 */
export function LogPanel({
  result,
  onOpenLocation,
  onFixPackage,
  onClearCache,
  onClose,
}: {
  result: CompileResult | null
  onOpenLocation: (file: string, line: number) => void
  /** Correction d'un package introuvable (absente en lecture seule). */
  onFixPackage?: FixPackage
  onClearCache: () => Promise<void>
  onClose: () => void
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
    fetch(logUrl)
      .then((response) => {
        if (!response.ok) throw new Error(`HTTP ${String(response.status)}`)
        return response.text()
      })
      .then(
        (text) => {
          if (active) setRaw({ url: logUrl, text })
        },
        (caught: unknown) => {
          const message = caught instanceof Error ? caught.message : String(caught)
          if (active) setRaw({ url: logUrl, text: `Log indisponible (${message}).` })
        },
      )
    return () => {
      active = false
    }
  }, [showRaw, logUrl])

  const close = (
    <Button
      variant="ghost"
      size="icon-sm"
      aria-label="Fermer les logs"
      data-testid="close-logs"
      onClick={onClose}
    >
      <XIcon />
    </Button>
  )
  if (result === null) {
    return (
      <div className="flex items-center justify-between p-3">
        <p className="text-sm text-muted-foreground">Aucune compilation pour l'instant.</p>
        {close}
      </div>
    )
  }
  const grouped = groupEntries(result.entries)

  const entry = (item: LogEntry, index: number, tone: string) => {
    const location = locationLabel(item)
    const clickable = item.file !== null && item.line !== null
    const missing = missingPackageOf(item)
    const button = (
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
    if (missing === null) return button
    return (
      <div key={index}>
        {button}
        <MissingPackageHint entry={item} missing={missing} onFix={onFixPackage} />
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b px-3">
        <Badge
          variant={result.status === 'success' ? 'secondary' : 'destructive'}
          data-testid="compile-status"
        >
          {STATUS_LABELS[result.status]}
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
        {close}
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
