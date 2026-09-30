'use client'

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
  FilePlusIcon,
  FileTextIcon,
  FolderIcon,
  FolderPlusIcon,
  ImageIcon,
  StarIcon,
  UploadIcon,
} from 'lucide-react'
import { type DragEvent, useRef, useState } from 'react'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { NameDialog } from '@/components/name-dialog'
import { api, type EntityType, type ProjectTree, uploadToProject } from '@/lib/api'
import { isInside, nestTree, type TreeNode } from '@/lib/tree'

const DRAG_TYPE = 'application/x-kaxolax-entity'

export type Selection = { type: 'document' | 'file'; id: string } | null

interface Props {
  projectId: string
  tree: ProjectTree
  mainDocumentId: string | null
  selection: Selection
  canEdit: boolean
  onSelect: (selection: Selection) => void
  onChanged: () => Promise<void>
  onSetMain: (documentId: string) => Promise<void>
  onError: (message: string) => void
}

type Dialog =
  | { kind: 'create'; entity: 'folder' | 'document'; parentId: string | null }
  | { kind: 'rename'; node: TreeNode }
  | { kind: 'delete'; node: TreeNode }
  | null

export function FileTree(props: Props) {
  const { projectId, tree, canEdit, onChanged, onError } = props
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const [dialog, setDialog] = useState<Dialog>(null)
  const [dropTarget, setDropTarget] = useState<string | null>(null)
  const [uploads, setUploads] = useState<string[]>([])
  const uploadInput = useRef<HTMLInputElement>(null)
  const uploadFolder = useRef<string | null>(null)
  const nodes = nestTree(tree)

  async function run(action: () => Promise<unknown>) {
    try {
      await action()
      await onChanged()
    } catch (caught) {
      onError(caught instanceof Error ? caught.message : String(caught))
    }
  }

  async function upload(files: File[], folderId: string | null) {
    if (files.length === 0) return
    setUploads((current) => [...current, ...files.map((file) => file.name)])
    for (const file of files) {
      try {
        await uploadToProject(projectId, file, folderId)
      } catch (caught) {
        onError(`${file.name} : ${caught instanceof Error ? caught.message : String(caught)}`)
      } finally {
        setUploads((current) => current.filter((name) => name !== file.name))
      }
    }
    await onChanged()
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
      void upload([...event.dataTransfer.files], folderId)
      return
    }
    const raw = event.dataTransfer.getData(DRAG_TYPE)
    if (!raw) return
    const moved = JSON.parse(raw) as { type: EntityType; id: string }
    if (moved.type === 'folder' && folderId !== null && isInside(tree, folderId, moved.id)) return
    void run(() => api.updateEntity(projectId, moved.type, moved.id, { folderId }))
  }

  function renderNode(node: TreeNode, depth: number) {
    const id = node.entity.id
    const isFolder = node.type === 'folder'
    const open = isFolder && !collapsed.has(id)
    const selected = props.selection?.id === id
    const isMain = node.type === 'document' && id === props.mainDocumentId
    const Icon = isFolder
      ? FolderIcon
      : node.type === 'document'
        ? FileTextIcon
        : node.entity.mimeType.startsWith('image/')
          ? ImageIcon
          : FileIcon
    return (
      <li key={id}>
        <div
          role="treeitem"
          aria-selected={selected}
          aria-expanded={isFolder ? open : undefined}
          data-testid={`tree-${node.type}`}
          data-path={node.entity.path}
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
            if (isFolder) {
              setCollapsed((current) => {
                const next = new Set(current)
                if (next.has(id)) next.delete(id)
                else next.add(id)
                return next
              })
            } else props.onSelect({ type: node.type, id })
          }}
          className={cn(
            'group flex h-7 cursor-pointer items-center gap-1 rounded pr-1 text-sm hover:bg-accent',
            selected && 'bg-accent font-medium',
            dropTarget === id && 'ring-2 ring-primary',
          )}
          style={{ paddingLeft: 4 + depth * 14 }}
        >
          {isFolder ? (
            open ? (
              <ChevronDownIcon className="size-3.5 shrink-0" />
            ) : (
              <ChevronRightIcon className="size-3.5 shrink-0" />
            )
          ) : (
            <span className="w-3.5 shrink-0" />
          )}
          <Icon className="size-4 shrink-0 text-muted-foreground" />
          <span className="truncate">{node.entity.name}</span>
          {isMain ? (
            <StarIcon
              className="size-3 shrink-0 fill-amber-400 text-amber-500"
              aria-label="Document principal"
            />
          ) : null}
          {canEdit ? (
            <DropdownMenu>
              <DropdownMenuTrigger
                asChild
                onClick={(event) => {
                  event.stopPropagation()
                }}
              >
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className="ml-auto size-6 opacity-0 group-hover:opacity-100 data-[state=open]:opacity-100"
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
                        setDialog({ kind: 'create', entity: 'document', parentId: id })
                      }}
                    >
                      Nouveau fichier ici
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      onSelect={() => {
                        setDialog({ kind: 'create', entity: 'folder', parentId: id })
                      }}
                    >
                      Nouveau dossier ici
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      onSelect={() => {
                        uploadFolder.current = id
                        uploadInput.current?.click()
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
                  <DropdownMenuItem onSelect={() => void run(() => props.onSetMain(id))}>
                    Définir comme document principal
                  </DropdownMenuItem>
                ) : null}
                <DropdownMenuItem
                  onSelect={() => {
                    setDialog({ kind: 'rename', node })
                  }}
                >
                  Renommer
                </DropdownMenuItem>
                <DropdownMenuItem
                  variant="destructive"
                  onSelect={() => {
                    setDialog({ kind: 'delete', node })
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
    <div className="flex h-full flex-col">
      <div className="flex h-10 shrink-0 items-center gap-1 border-b px-2">
        <span className="mr-auto text-xs font-semibold uppercase text-muted-foreground">
          Fichiers
        </span>
        {canEdit ? (
          <>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Nouveau fichier"
              onClick={() => {
                setDialog({ kind: 'create', entity: 'document', parentId: null })
              }}
            >
              <FilePlusIcon />
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Nouveau dossier"
              onClick={() => {
                setDialog({ kind: 'create', entity: 'folder', parentId: null })
              }}
            >
              <FolderPlusIcon />
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Uploader des fichiers"
              onClick={() => {
                uploadFolder.current = null
                uploadInput.current?.click()
              }}
            >
              <UploadIcon />
            </Button>
          </>
        ) : null}
        <input
          ref={uploadInput}
          type="file"
          multiple
          className="hidden"
          data-testid="upload-input"
          onChange={(event) => {
            const files = [...(event.target.files ?? [])]
            event.target.value = ''
            void upload(files, uploadFolder.current)
          }}
        />
      </div>
      <div
        className={cn('flex-1 overflow-auto p-1', dropTarget === 'root' && 'bg-accent/60')}
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
        <ul role="tree">{nodes.map((node) => renderNode(node, 0))}</ul>
        {uploads.length > 0 ? (
          <p className="px-2 py-1 text-xs text-muted-foreground" data-testid="uploads-in-progress">
            Upload : {uploads.join(', ')}…
          </p>
        ) : null}
        {canEdit ? (
          <p className="px-2 py-3 text-xs text-muted-foreground">
            Glissez des fichiers ici pour les uploader.
          </p>
        ) : null}
      </div>

      <NameDialog
        key={
          dialog?.kind === 'create'
            ? `create-${dialog.entity}-${String(dialog.parentId)}`
            : 'create'
        }
        open={dialog?.kind === 'create'}
        onOpenChange={(open) => {
          if (!open) setDialog(null)
        }}
        title={
          dialog?.kind === 'create' && dialog.entity === 'folder'
            ? 'Nouveau dossier'
            : 'Nouveau fichier'
        }
        label="Nom"
        initialValue={dialog?.kind === 'create' && dialog.entity === 'document' ? '.tex' : ''}
        submitLabel="Créer"
        onSubmit={async (name) => {
          if (dialog?.kind !== 'create') return
          if (dialog.entity === 'folder') await api.createFolder(projectId, name, dialog.parentId)
          else {
            const { document } = await api.createDocument(projectId, name, dialog.parentId)
            props.onSelect({ type: 'document', id: document.id })
          }
          await onChanged()
        }}
      />
      <NameDialog
        key={dialog?.kind === 'rename' ? dialog.node.entity.id : 'rename'}
        open={dialog?.kind === 'rename'}
        onOpenChange={(open) => {
          if (!open) setDialog(null)
        }}
        title="Renommer"
        label="Nouveau nom"
        initialValue={dialog?.kind === 'rename' ? dialog.node.entity.name : ''}
        submitLabel="Renommer"
        onSubmit={async (name) => {
          if (dialog?.kind !== 'rename') return
          await api.updateEntity(projectId, dialog.node.type, dialog.node.entity.id, { name })
          await onChanged()
        }}
      />
      <ConfirmDialog
        open={dialog?.kind === 'delete'}
        onOpenChange={(open) => {
          if (!open) setDialog(null)
        }}
        title="Supprimer ?"
        description={
          dialog?.kind === 'delete'
            ? dialog.node.type === 'folder'
              ? `Le dossier « ${dialog.node.entity.name} » et tout son contenu seront supprimés.`
              : `« ${dialog.node.entity.name} » sera supprimé.`
            : ''
        }
        confirmLabel="Supprimer"
        onConfirm={() => {
          if (dialog?.kind !== 'delete') return
          const { node } = dialog
          void run(async () => {
            await api.deleteEntity(projectId, node.type, node.entity.id)
            if (props.selection?.id === node.entity.id) props.onSelect(null)
          })
        }}
      />
    </div>
  )
}
