'use client'

import type { PresenceUser } from '@kaxolax/contracts'
import { MARKDOWN_IMPORT_DIALOG } from '@kaxolax/editor'
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  cn,
} from '@kaxolax/ui'
import {
  ChevronDownIcon,
  ChevronRightIcon,
  EllipsisIcon,
  FileIcon,
  FileTextIcon,
  FolderIcon,
  FolderOpenIcon,
  ImageIcon,
  StarIcon,
} from 'lucide-react'
import { type DragEvent, type KeyboardEvent, useRef, useState } from 'react'
import type { EntityType, ProjectTree } from '@/lib/api'
import { nestTree, type TreeNode, treeKeyEffect, visibleRows } from '@/lib/tree'
import { isMarkdownPath } from '@/lib/markdown-import'
import { useFileActions } from '../file-actions'
import { useEditorActions } from '../workspace-actions'

const DRAG_TYPE = 'application/x-kaxolax-entity'

interface Props {
  tree: ProjectTree
  mainDocumentId: string | null
  /** Document ou fichier de l'onglet actif, surligné. */
  activeId: string | null
  onOpen: (id: string) => void
  /** Collaborateurs qui ont chaque fichier ouvert (pastilles de couleur). */
  presence?: ReadonlyMap<string, readonly PresenceUser[]>
}

/** Pastilles affichées au plus par fichier (les autres sont comptées dans le libellé). */
const MAX_PRESENCE_DOTS = 3

/** Pastilles de couleur des collaborateurs qui ont ce fichier ouvert. */
function PresenceDots({ users }: { users: readonly PresenceUser[] }) {
  const names = users.map((user) => user.name).join(', ')
  return (
    <span
      role="img"
      aria-label={`Ouvert par ${names}`}
      title={`Ouvert par ${names}`}
      className="ml-auto flex shrink-0 items-center -space-x-0.5 pl-1"
      data-testid="tree-presence"
    >
      {users.slice(0, MAX_PRESENCE_DOTS).map((user) => (
        <span
          key={user.id}
          className="size-2 rounded-full ring-1 ring-sidebar"
          style={{ backgroundColor: user.color }}
        />
      ))}
    </span>
  )
}

/**
 * Arborescence du projet : ouverture d'un fichier, menu par élément (créer, uploader, renommer,
 * supprimer, document principal), glisser-déposer pour déplacer ou uploader. Clavier (motif ARIA
 * « tree view ») : une seule ligne dans l'ordre de tabulation, flèches, Début, Fin, Entrée ;
 * Maj+F10 ou la touche Menu ouvre le menu de la ligne, F2 renomme, Suppr supprime.
 */
export function FileTree({ tree, mainDocumentId, activeId, onOpen, presence }: Props) {
  const files = useFileActions()
  const actions = useEditorActions()
  const { canEdit } = files
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const [dropTarget, setDropTarget] = useState<string | null>(null)
  // Ligne focalisée au clavier, et ligne dont le menu d'actions est ouvert.
  const [focused, setFocused] = useState<string | null>(null)
  const [menuFor, setMenuFor] = useState<string | null>(null)
  const list = useRef<HTMLUListElement>(null)
  const nodes = nestTree(tree)
  const rows = visibleRows(nodes, collapsed)
  const visible = (id: string | null) =>
    id !== null && rows.some((row) => row.node.entity.id === id)
  // Seule ligne atteignable par Tab : la dernière focalisée, sinon l'active, sinon la première.
  const tabStop = visible(focused)
    ? focused
    : visible(activeId)
      ? activeId
      : (rows[0]?.node.entity.id ?? null)

  function toggle(id: string) {
    setCollapsed((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function focusRow(id: string) {
    setFocused(id)
    list.current?.querySelector<HTMLElement>(`[data-entity-id="${id}"]`)?.focus()
  }

  function onKeyDown(event: KeyboardEvent, node: TreeNode) {
    if (event.target !== event.currentTarget) return
    const id = node.entity.id
    if (canEdit && (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10'))) {
      event.preventDefault()
      setMenuFor(id)
      return
    }
    if (canEdit && event.key === 'F2') {
      event.preventDefault()
      files.rename(node)
      return
    }
    if (canEdit && event.key === 'Delete') {
      event.preventDefault()
      files.remove(node)
      return
    }
    const effect = treeKeyEffect(rows, id, event.key)
    if (effect === null) return
    event.preventDefault()
    if (effect.kind === 'focus') focusRow(effect.id)
    else if (effect.kind === 'toggle') toggle(effect.id)
    else onOpen(effect.id)
  }

  function onDragStart(event: DragEvent, node: TreeNode) {
    event.dataTransfer.setData(DRAG_TYPE, JSON.stringify({ type: node.type, id: node.entity.id }))
    event.dataTransfer.effectAllowed = 'move'
  }

  function onDragOver(event: DragEvent, target: string) {
    if (!canEdit) return
    const types = event.dataTransfer.types
    if (!types.includes(DRAG_TYPE) && !types.includes('Files')) return
    event.preventDefault()
    event.stopPropagation()
    setDropTarget(target)
  }

  /** Dépôt sur un dossier (ou la racine) : fichiers du système à uploader, ou entité à déplacer. */
  function onDrop(event: DragEvent, folderId: string | null) {
    event.preventDefault()
    event.stopPropagation()
    setDropTarget(null)
    if (!canEdit) return
    if (event.dataTransfer.files.length > 0) {
      void files.upload([...event.dataTransfer.files], folderId)
      return
    }
    const raw = event.dataTransfer.getData(DRAG_TYPE)
    if (!raw) return
    const moved = JSON.parse(raw) as { type: EntityType; id: string }
    files.move(moved.type, moved.id, folderId)
  }

  function renderNode(node: TreeNode, depth: number) {
    const id = node.entity.id
    const isFolder = node.type === 'folder'
    const open = isFolder && !collapsed.has(id)
    const selected = activeId === id
    const isMain = node.type === 'document' && id === mainDocumentId
    const openedBy = isFolder ? undefined : presence?.get(id)
    const Icon = isFolder
      ? open
        ? FolderOpenIcon
        : FolderIcon
      : node.type === 'document'
        ? FileTextIcon
        : node.entity.mimeType.startsWith('image/')
          ? ImageIcon
          : FileIcon
    return (
      <li key={id} role="none">
        <div
          role="treeitem"
          aria-level={depth + 1}
          aria-selected={selected}
          aria-expanded={isFolder ? open : undefined}
          data-testid={`tree-${node.type}`}
          data-path={node.entity.path}
          data-entity-id={id}
          tabIndex={id === tabStop ? 0 : -1}
          onFocus={(event) => {
            if (event.target === event.currentTarget) setFocused(id)
          }}
          onKeyDown={(event) => {
            onKeyDown(event, node)
          }}
          draggable={canEdit}
          onDragStart={(event) => {
            onDragStart(event, node)
          }}
          onDragOver={
            isFolder
              ? (event) => {
                  onDragOver(event, id)
                }
              : undefined
          }
          onDragLeave={
            isFolder
              ? () => {
                  setDropTarget(null)
                }
              : undefined
          }
          onDrop={
            isFolder
              ? (event) => {
                  onDrop(event, id)
                }
              : undefined
          }
          onClick={() => {
            if (isFolder) toggle(id)
            else onOpen(id)
          }}
          className={cn(
            'group flex h-7 cursor-pointer items-center gap-1.5 rounded-md pr-1 text-sm text-sidebar-foreground outline-none hover:bg-sidebar-accent/60 focus-visible:ring-[3px] focus-visible:ring-sidebar-ring/50',
            selected && 'bg-sidebar-accent font-medium text-sidebar-accent-foreground',
            dropTarget === id && 'ring-2 ring-sidebar-ring',
          )}
          style={{ paddingLeft: 4 + depth * 14 }}
        >
          {isFolder ? (
            open ? (
              <ChevronDownIcon className="size-3.5 shrink-0 text-sidebar-muted-foreground" />
            ) : (
              <ChevronRightIcon className="size-3.5 shrink-0 text-sidebar-muted-foreground" />
            )
          ) : (
            <span className="w-3.5 shrink-0" />
          )}
          <Icon
            className={cn(
              'size-4 shrink-0',
              selected ? 'text-sidebar-primary' : 'text-sidebar-muted-foreground',
            )}
          />
          <span className="truncate">{node.entity.name}</span>
          {isMain ? (
            <StarIcon
              className="size-3 shrink-0 fill-warning text-warning"
              aria-label="Document principal"
            />
          ) : null}
          {openedBy && openedBy.length > 0 ? <PresenceDots users={openedBy} /> : null}
          {canEdit ? (
            <DropdownMenu
              open={menuFor === id}
              onOpenChange={(next) => {
                setMenuFor(next ? id : null)
              }}
            >
              <DropdownMenuTrigger
                asChild
                onClick={(event) => {
                  event.stopPropagation()
                }}
              >
                <Button
                  variant="ghost"
                  size="icon-xs"
                  className={cn(
                    'opacity-0 hover:bg-sidebar-accent group-hover:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100',
                    // Les pastilles de présence, quand il y en a, poussent déjà le bouton à droite.
                    !openedBy?.length && 'ml-auto',
                  )}
                  // Hors de l'ordre de tabulation : Maj+F10 sur la ligne ouvre le même menu.
                  tabIndex={-1}
                  aria-label={`Actions pour ${node.entity.name}`}
                >
                  <EllipsisIcon />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align="end"
                onClick={(event) => {
                  event.stopPropagation()
                }}
              >
                {isFolder ? (
                  <>
                    <DropdownMenuItem
                      onSelect={() => {
                        files.createDocument(id)
                      }}
                    >
                      Nouveau fichier ici
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      onSelect={() => {
                        files.createFolder(id)
                      }}
                    >
                      Nouveau dossier ici
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      onSelect={() => {
                        files.chooseUploads(id)
                      }}
                    >
                      Uploader ici
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                  </>
                ) : null}
                {node.type === 'document' &&
                node.entity.name.toLowerCase().endsWith('.tex') &&
                !isMain ? (
                  <DropdownMenuItem
                    onSelect={() => {
                      files.setMain(id)
                    }}
                  >
                    Définir comme document principal
                  </DropdownMenuItem>
                ) : null}
                {node.type === 'document' && isMarkdownPath(node.entity.name) ? (
                  <DropdownMenuItem
                    onSelect={() => {
                      actions.host.openDialog?.(MARKDOWN_IMPORT_DIALOG, {
                        kind: 'markdown-import',
                        documentId: id,
                      })
                    }}
                  >
                    Convertir en LaTeX…
                  </DropdownMenuItem>
                ) : null}
                <DropdownMenuItem
                  onSelect={() => {
                    files.rename(node)
                  }}
                >
                  Renommer
                </DropdownMenuItem>
                <DropdownMenuItem
                  variant="destructive"
                  onSelect={() => {
                    files.remove(node)
                  }}
                >
                  Supprimer
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          ) : null}
        </div>
        {isFolder && open && node.children.length > 0 ? (
          <ul role="group">{node.children.map((child) => renderNode(child, depth + 1))}</ul>
        ) : null}
      </li>
    )
  }

  return (
    <div
      className={cn(
        'h-full overflow-auto px-2 py-1',
        dropTarget === 'root' && 'bg-sidebar-accent/40',
      )}
      onDragOver={(event) => {
        onDragOver(event, 'root')
      }}
      onDragLeave={() => {
        setDropTarget(null)
      }}
      onDrop={(event) => {
        onDrop(event, null)
      }}
      data-testid="file-tree"
    >
      <ul ref={list} role="tree" aria-label="Fichiers du projet">
        {nodes.map((node) => renderNode(node, 0))}
      </ul>
      {files.uploads.length > 0 ? (
        <p
          className="px-2 py-1 text-xs text-sidebar-muted-foreground"
          data-testid="uploads-in-progress"
        >
          Upload : {files.uploads.join(', ')}…
        </p>
      ) : null}
      {canEdit ? (
        <p className="px-2 py-3 text-xs text-sidebar-muted-foreground">
          Glissez des fichiers ici pour les uploader.
        </p>
      ) : null}
    </div>
  )
}
