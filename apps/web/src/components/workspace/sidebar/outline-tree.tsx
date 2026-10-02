'use client'

import type { OutlineNode } from '@kaxolax/editor'
import { cn } from '@kaxolax/ui'
import { useEffect, useRef } from 'react'

/** Ligne du plan, à plat : titre et profondeur d'affichage. */
interface OutlineRow {
  node: OutlineNode
  depth: number
}

function flatten(nodes: readonly OutlineNode[], depth = 0, rows: OutlineRow[] = []): OutlineRow[] {
  for (const node of nodes) {
    rows.push({ node, depth })
    flatten(node.children, depth + 1, rows)
  }
  return rows
}

/**
 * Plan du document (section Outline de la sidebar) : titres indentés par niveau, section courante
 * surlignée et gardée visible ; un clic ouvre le fichier du titre à sa ligne.
 */
export function OutlineTree({
  nodes,
  current,
  activePath,
  onSelect,
}: {
  nodes: readonly OutlineNode[]
  current: OutlineNode | null
  /** Fichier de l'onglet actif : les titres des fichiers inclus portent le nom du leur. */
  activePath: string | null
  onSelect: (file: string, line: number) => void
}) {
  const list = useRef<HTMLUListElement>(null)
  const rows = flatten(nodes)

  useEffect(() => {
    list.current?.querySelector('[aria-current="location"]')?.scrollIntoView({ block: 'nearest' })
  }, [current])

  if (rows.length === 0) {
    return (
      <p className="px-2 py-1 text-xs text-sidebar-muted-foreground" data-testid="outline-empty">
        {activePath === null
          ? 'Ouvrez un document pour voir son plan.'
          : 'Aucune section dans ce document.'}
      </p>
    )
  }

  return (
    <ul ref={list} className="grid gap-px text-sm" data-testid="outline">
      {rows.map(({ node, depth }) => {
        const file = node.file ?? activePath ?? ''
        const isCurrent = node === current
        return (
          <li key={`${file}:${String(node.from)}`}>
            <button
              type="button"
              className={cn(
                'flex w-full min-w-0 items-center gap-1.5 rounded-md py-1 pr-2 text-left outline-none hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-[3px] focus-visible:ring-sidebar-ring/50',
                isCurrent
                  ? 'bg-sidebar-accent font-medium text-sidebar-accent-foreground'
                  : 'text-sidebar-foreground/85',
              )}
              style={{ paddingLeft: `${String(0.5 + depth * 0.75)}rem` }}
              aria-current={isCurrent ? 'location' : undefined}
              title={file === activePath ? node.title : `${node.title} (${file})`}
              onClick={() => {
                onSelect(file, node.line)
              }}
            >
              <span className="truncate">{node.shortTitle ?? node.title}</span>
              {file !== activePath ? (
                <span className="ml-auto shrink-0 truncate text-[0.7rem] text-sidebar-muted-foreground">
                  {file.split('/').at(-1)}
                </span>
              ) : null}
            </button>
          </li>
        )
      })}
    </ul>
  )
}
