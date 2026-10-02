'use client'

import type { SpellcheckMenu as SpellcheckMenuState } from '@kaxolax/editor'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Spinner,
} from '@kaxolax/ui'
import { BookPlusIcon } from 'lucide-react'
import { useEffect, useState } from 'react'
import { spellcheckErrorMessage } from '@/lib/editor-settings'

/**
 * Menu de suggestions du correcteur (clic droit sur un mot souligné, ou F7) : corrections
 * proposées par Hunspell, puis ajout au dictionnaire personnel. Ancré à la position du mot ;
 * navigable au clavier (le focus revient dans l'éditeur à la fermeture).
 */
export function SpellcheckMenu({
  menu,
  readOnly,
  addRefusal,
  onClose,
  focusEditor,
}: {
  menu: SpellcheckMenuState
  /** Lecture seule : pas de remplacement, seulement le dictionnaire personnel. */
  readOnly: boolean
  /** Raison pour laquelle l'ajout au dictionnaire personnel est impossible (plein…), sinon null. */
  addRefusal: string | null
  onClose: () => void
  /** Rend le focus à l'éditeur à la fermeture du menu. */
  focusEditor: () => void
}) {
  const [suggestions, setSuggestions] = useState<
    | { menu: SpellcheckMenuState; words: string[] }
    | { menu: SpellcheckMenuState; error: string }
    | null
  >(null)

  useEffect(() => {
    let active = true
    menu.suggestions().then(
      (words) => {
        if (active) setSuggestions({ menu, words })
      },
      (caught: unknown) => {
        if (active) setSuggestions({ menu, error: spellcheckErrorMessage(caught) })
      },
    )
    return () => {
      active = false
    }
  }, [menu])

  const current = suggestions?.menu === menu ? suggestions : null
  return (
    <DropdownMenu
      open
      modal={false}
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    >
      <DropdownMenuTrigger asChild>
        <span
          aria-hidden
          className="pointer-events-none fixed size-0"
          style={{ left: menu.x, top: menu.y }}
        />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        className="min-w-52"
        data-testid="spellcheck-menu"
        onCloseAutoFocus={(event) => {
          event.preventDefault()
          focusEditor()
        }}
      >
        <DropdownMenuLabel className="font-normal text-muted-foreground">
          « <span className="font-medium text-foreground">{menu.word}</span> »
        </DropdownMenuLabel>
        {current === null ? (
          <DropdownMenuItem disabled>
            <Spinner label="" /> Suggestions…
          </DropdownMenuItem>
        ) : 'error' in current ? (
          <DropdownMenuItem disabled>{current.error}</DropdownMenuItem>
        ) : current.words.length === 0 ? (
          <DropdownMenuItem disabled>Aucune suggestion</DropdownMenuItem>
        ) : (
          current.words.map((word) => (
            <DropdownMenuItem
              key={word}
              disabled={readOnly}
              className="font-medium"
              onSelect={() => {
                menu.replace(word)
              }}
            >
              {word}
            </DropdownMenuItem>
          ))
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem
          disabled={addRefusal !== null}
          onSelect={() => {
            menu.addToDictionary()
          }}
          data-testid="spellcheck-add"
        >
          <BookPlusIcon /> Ajouter au dictionnaire personnel
        </DropdownMenuItem>
        {addRefusal !== null ? (
          <p
            role="status"
            className="max-w-64 px-2 pb-1.5 text-xs text-destructive"
            data-testid="spellcheck-add-refused"
          >
            {addRefusal}
          </p>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
