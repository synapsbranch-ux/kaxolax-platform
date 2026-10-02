'use client'

import type { SpellcheckLanguage } from '@kaxolax/contracts'
import type { EditorKeymapMode } from '@kaxolax/editor'
import { Button, SimpleTooltip, cn } from '@kaxolax/ui'
import { SettingsIcon, SpellCheckIcon, WholeWordIcon } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { EditorHandle } from './code-editor'

const LANGUAGE_LABELS: Record<SpellcheckLanguage, string> = { fr: 'Français', en: 'Anglais' }
const KEYMAP_LABELS: Record<EditorKeymapMode, string | null> = {
  default: null,
  vim: 'Vim',
  emacs: 'Emacs',
}

/** Ligne et colonne du curseur (1 = première), relues après chaque déplacement. */
function useCursor(editor: EditorHandle | null): { line: number; column: number } | null {
  const [cursor, setCursor] = useState<{
    editor: EditorHandle
    line: number
    column: number
  } | null>(null)
  useEffect(() => {
    if (editor === null) return
    let frame: number | null = null
    const read = () => {
      frame = null
      const { state } = editor.view
      const head = state.selection.main.head
      const line = state.doc.lineAt(head)
      setCursor({ editor, line: line.number, column: head - line.from + 1 })
    }
    read()
    // Un seul calcul par image pendant une frappe rapide.
    const unsubscribe = editor.subscribe(() => {
      frame ??= requestAnimationFrame(read)
    })
    return () => {
      if (frame !== null) cancelAnimationFrame(frame)
      unsubscribe()
    }
  }, [editor])
  return cursor?.editor === editor ? cursor : null
}

/**
 * Barre d'état sous l'éditeur : position du curseur, raccourcis Vim ou Emacs, langue et état du
 * correcteur (vers les paramètres), compteur de mots et paramètres de l'éditeur.
 */
export function EditorStatusBar({
  editor,
  documentOpen,
  keymap,
  spellcheck,
  onWordCount,
  onSettings,
}: {
  editor: EditorHandle | null
  /** Un document texte est ouvert (sinon : aperçu d'un fichier, aucune position). */
  documentOpen: boolean
  keymap: EditorKeymapMode
  /** `applies` : faux pour un fichier que le correcteur ne relit pas (.bib, .sty…). */
  spellcheck: {
    enabled: boolean
    applies: boolean
    language: SpellcheckLanguage
    error: string | null
  }
  onWordCount: () => void
  onSettings: (section: 'editor' | 'spellcheck' | 'project') => void
}) {
  const cursor = useCursor(documentOpen ? editor : null)
  const keymapLabel = KEYMAP_LABELS[keymap]
  const item =
    'h-5 gap-1 rounded-sm px-1.5 text-[11px] font-normal text-editor-tab-foreground hover:bg-editor-tab-active [&_svg]:size-3.5'
  return (
    <div
      role="group"
      aria-label="Barre d’état de l’éditeur"
      className="flex h-6 shrink-0 items-center gap-1 overflow-hidden border-t border-editor-border bg-editor-tabbar px-2 text-[11px] text-editor-tab-foreground"
      data-testid="editor-status-bar"
    >
      {cursor ? (
        <span className="whitespace-nowrap tabular-nums" data-testid="cursor-position">
          Ligne {cursor.line}, col. {cursor.column}
        </span>
      ) : null}
      {keymapLabel ? (
        <span className="rounded-sm border border-editor-border px-1 font-medium">
          {keymapLabel}
        </span>
      ) : null}
      <span className="ml-auto flex items-center gap-0.5">
        <SimpleTooltip
          label={
            spellcheck.error ??
            (!spellcheck.enabled
              ? 'Correcteur désactivé'
              : spellcheck.applies
                ? `Correcteur : ${LANGUAGE_LABELS[spellcheck.language].toLowerCase()} (langue du projet)`
                : 'Correcteur inactif pour ce type de fichier (seuls .tex, .ltx et .txt sont relus)')
          }
        >
          <Button
            variant="ghost"
            size="xs"
            className={cn(item, spellcheck.error !== null && 'text-destructive')}
            aria-label={`Correcteur orthographique : ${
              spellcheck.enabled ? LANGUAGE_LABELS[spellcheck.language] : 'désactivé'
            }`}
            onClick={() => {
              onSettings(spellcheck.enabled ? 'project' : 'spellcheck')
            }}
            data-testid="status-spellcheck"
          >
            <SpellCheckIcon />
            <span className={cn(!spellcheck.enabled && 'line-through')}>
              {spellcheck.language.toUpperCase()}
            </span>
          </Button>
        </SimpleTooltip>
        <Button
          variant="ghost"
          size="xs"
          className={item}
          onClick={onWordCount}
          data-testid="status-word-count"
        >
          <WholeWordIcon /> <span className="hidden sm:inline">Mots</span>
          <span className="sr-only sm:hidden">Compteur de mots</span>
        </Button>
        <SimpleTooltip label="Paramètres de l’éditeur">
          <Button
            variant="ghost"
            size="xs"
            className={item}
            aria-label="Paramètres de l’éditeur"
            onClick={() => {
              onSettings('editor')
            }}
            data-testid="status-settings"
          >
            <SettingsIcon />
          </Button>
        </SimpleTooltip>
      </span>
    </div>
  )
}
