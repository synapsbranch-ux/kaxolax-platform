'use client'

import type { Compiler, CompileResult } from '@kaxolax/contracts'
import {
  Button,
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
  SimpleTooltip,
  Spinner,
  cn,
} from '@kaxolax/ui'
import { CheckIcon, ChevronDownIcon, CircleAlertIcon, PlayIcon, TimerOffIcon } from 'lucide-react'
import { type CompilePhase, phaseLabel } from '@/lib/builds'
import { compileStatusKind } from '@/lib/pdf'

export const COMPILERS: { id: Compiler; label: string }[] = [
  { id: 'pdflatex', label: 'pdfLaTeX' },
  { id: 'xelatex', label: 'XeLaTeX' },
  { id: 'lualatex', label: 'LuaLaTeX' },
]

export interface CompileSettings {
  compiler: Compiler
  autoCompile: boolean
  draft: boolean
  haltOnFirstError: boolean
}

/**
 * Pastille de statut de la colonne PDF : un clic relance la compilation (Ctrl+Entrée) ; le menu ▾
 * règle l'auto-compilation, le compilateur, le mode brouillon, l'arrêt à la première erreur, et
 * donne l'arrêt, le vidage du cache et les logs.
 */
export function CompileStatus({
  result,
  compiling,
  phase = null,
  settings,
  canEdit,
  onCompile,
  onStop,
  onClearCache,
  onShowLogs,
  onChange,
}: {
  result: CompileResult | null
  compiling: boolean
  /** Étape en cours : « Préparation du compilateur… » pendant le réveil du conteneur. */
  phase?: CompilePhase | null
  settings: CompileSettings
  /** Le compilateur est un réglage du projet : éditeurs et propriétaire seulement. */
  canEdit: boolean
  onCompile: () => void
  onStop: () => void
  onClearCache: () => void
  onShowLogs: () => void
  onChange: (change: Partial<CompileSettings>) => void
}) {
  const kind = compileStatusKind(result, compiling)
  const errors = result?.entries.filter((entry) => entry.level === 'error').length ?? 0

  return (
    <div
      className={cn(
        'flex h-7 items-center rounded-md border text-xs font-medium shadow-xs',
        kind === 'success' && 'border-success/40 bg-success/10 text-success',
        (kind === 'errors' || kind === 'failed' || kind === 'timeout') &&
          'border-destructive/40 bg-destructive/10 text-destructive',
        (kind === 'never' || kind === 'compiling') &&
          'border-pdf-border bg-pdf-toolbar text-pdf-toolbar-foreground',
      )}
      data-status={kind}
    >
      <SimpleTooltip label="Recompiler" shortcut="Mod-Enter">
        <button
          type="button"
          className="flex h-full items-center gap-1.5 rounded-l-md px-2.5 outline-none hover:bg-black/5 focus-visible:ring-[3px] focus-visible:ring-ring/50"
          onClick={onCompile}
          data-testid="recompile"
        >
          {kind === 'compiling' ? (
            <>
              <Spinner label="" className="size-3.5" />
              <span aria-live="polite">{phase === null ? 'Compilation…' : phaseLabel(phase)}</span>
            </>
          ) : kind === 'success' ? (
            <>
              <CheckIcon className="size-3.5" /> Compilé
            </>
          ) : kind === 'errors' ? (
            <>
              <CircleAlertIcon className="size-3.5" />
              <span data-testid="error-count">{errors}</span>
              {errors > 1 ? 'erreurs' : 'erreur'}
            </>
          ) : kind === 'timeout' ? (
            <>
              <TimerOffIcon className="size-3.5" /> Délai dépassé
            </>
          ) : kind === 'failed' ? (
            <>
              <CircleAlertIcon className="size-3.5" /> Échec
            </>
          ) : (
            <>
              <PlayIcon className="size-3.5" /> Compiler
            </>
          )}
        </button>
      </SimpleTooltip>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            className="h-full w-6 rounded-l-none rounded-r-md border-l border-current/20 p-0 hover:bg-black/5 hover:text-current"
            aria-label="Options de compilation"
            data-testid="compile-menu"
          >
            <ChevronDownIcon className="size-3.5" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-64">
          <DropdownMenuItem onSelect={onCompile}>
            Recompiler
            <DropdownMenuShortcut shortcut="Mod-Enter" />
          </DropdownMenuItem>
          <DropdownMenuItem disabled={!compiling} onSelect={onStop}>
            Arrêter la compilation
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuCheckboxItem
            checked={settings.autoCompile}
            onCheckedChange={(checked) => {
              onChange({ autoCompile: checked })
            }}
          >
            Compilation automatique
          </DropdownMenuCheckboxItem>
          <DropdownMenuCheckboxItem
            checked={settings.draft}
            onCheckedChange={(checked) => {
              onChange({ draft: checked })
            }}
          >
            Mode brouillon
          </DropdownMenuCheckboxItem>
          <DropdownMenuCheckboxItem
            checked={settings.haltOnFirstError}
            onCheckedChange={(checked) => {
              onChange({ haltOnFirstError: checked })
            }}
          >
            Arrêter à la première erreur
          </DropdownMenuCheckboxItem>
          <DropdownMenuSeparator />
          <DropdownMenuLabel>Compilateur</DropdownMenuLabel>
          <DropdownMenuRadioGroup
            value={settings.compiler}
            onValueChange={(value) => {
              const compiler = COMPILERS.find((candidate) => candidate.id === value)
              if (compiler) onChange({ compiler: compiler.id })
            }}
          >
            {COMPILERS.map((compiler) => (
              <DropdownMenuRadioItem key={compiler.id} value={compiler.id} disabled={!canEdit}>
                {compiler.label}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={onClearCache}>Vider le cache</DropdownMenuItem>
          <DropdownMenuItem onSelect={onShowLogs}>Voir les logs</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}
