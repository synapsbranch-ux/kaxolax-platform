'use client'

import { ACTION_MENUS, type EditorAction } from '@kaxolax/editor'
import {
  Menubar,
  MenubarContent,
  MenubarItem,
  MenubarMenu,
  MenubarSeparator,
  MenubarTrigger,
  KbdShortcut,
} from '@kaxolax/ui'
import { Fragment, useEffect, useState } from 'react'
import { type EditorActions, useEditorActions } from '../workspace-actions'
import { ActionIcon } from './action-icon'

/**
 * Barre d'outils (bouton Tools) : un menu déroulant par entrée de `ACTION_MENUS` (Fichier, Format,
 * Structures, Maths, Graphiques, Packages, Rechercher, Remplacer), rempli par le registre
 * d'actions. Les outils des tâches suivantes s'y ajoutent en s'enregistrant dans le registre
 * (`useEditorActions`). La disponibilité (lecture seule, éditeur ouvert) est évaluée à l'ouverture
 * d'un menu, le contexte relu à l'exécution.
 */
export function ToolsBar() {
  const actions = useEditorActions()
  const { registry } = actions
  // Nouveau rendu à chaque ajout ou retrait d'actions.
  const [, setVersion] = useState(0)
  useEffect(
    () =>
      registry.subscribe(() => {
        setVersion((version) => version + 1)
      }),
    [registry],
  )
  return (
    <Menubar
      aria-label="Outils"
      className="h-toolbar shrink-0 gap-0.5 overflow-x-auto rounded-none border-0 border-b border-editor-border bg-editor-toolbar px-1.5 text-editor-toolbar-foreground shadow-none"
      data-testid="tools-bar"
    >
      {ACTION_MENUS.map((menu) => {
        const items = registry.byMenu(menu.id)
        return (
          <MenubarMenu key={menu.id}>
            <MenubarTrigger
              disabled={items.length === 0}
              className="h-7 shrink-0 px-2 text-xs font-medium data-[state=open]:bg-editor-tab-active"
              data-menu={menu.id}
            >
              {menu.label}
            </MenubarTrigger>
            <MenubarContent
              align="start"
              className="max-h-[70vh] min-w-60 overflow-y-auto"
              // Le focus reste où l'action l'a mis (l'éditeur), pas sur le menu.
              onCloseAutoFocus={(event) => {
                event.preventDefault()
              }}
            >
              <MenuItems actions={actions} items={items} />
            </MenubarContent>
          </MenubarMenu>
        )
      })}
    </Menubar>
  )
}

/** Éléments d'un menu ouvert, séparés par groupe ; disponibilité évaluée à l'ouverture. */
function MenuItems({ actions, items }: { actions: EditorActions; items: EditorAction[] }) {
  const current = actions.context()
  return items.map((action, index) => {
    const previous = items[index - 1]
    const separated = previous !== undefined && previous.group !== action.group
    return (
      <Fragment key={action.id}>
        {separated ? <MenubarSeparator /> : null}
        <MenubarItem
          disabled={!actions.registry.isEnabled(action.id, current)}
          data-action={action.id}
          onSelect={() => {
            actions.run(action.id)
          }}
        >
          <ActionIcon name={action.icon} />
          {action.label}
          {action.shortcut === undefined ? null : (
            <KbdShortcut shortcut={action.shortcut} className="ml-auto pl-4" />
          )}
        </MenubarItem>
      </Fragment>
    )
  })
}
