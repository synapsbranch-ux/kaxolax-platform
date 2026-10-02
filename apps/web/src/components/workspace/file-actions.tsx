'use client'

import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
} from 'react'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { NameDialog } from '@/components/name-dialog'
import { api, type EntityType, errorMessage, type ProjectTree, uploadToProject } from '@/lib/api'
import { isInside, type TreeNode } from '@/lib/tree'

/**
 * Actions sur l'arborescence, partagées par la sidebar (arbre, menu +), la barre Tools (menu
 * Fichier) et les tâches suivantes : création, upload, renommage, déplacement, suppression.
 */
export interface FileActions {
  canEdit: boolean
  createDocument: (parentId: string | null) => void
  createFolder: (parentId: string | null) => void
  /** Ouvre le sélecteur de fichiers du système ; les fichiers vont dans `folderId`. */
  chooseUploads: (folderId: string | null) => void
  upload: (files: File[], folderId: string | null) => Promise<void>
  rename: (node: TreeNode) => void
  remove: (node: TreeNode) => void
  /** Déplace une entité dans un dossier (null : racine) ; refusé dans ses propres sous-dossiers. */
  move: (type: EntityType, id: string, folderId: string | null) => void
  setMain: (documentId: string) => void
  /** Noms des fichiers en cours d'upload. */
  uploads: string[]
}

const FileActionsContext = createContext<FileActions | null>(null)

type Dialog =
  | { kind: 'create'; entity: 'folder' | 'document'; parentId: string | null }
  | { kind: 'rename'; node: TreeNode }
  | { kind: 'delete'; node: TreeNode }
  | null

export function FileActionsProvider({
  projectId,
  tree,
  canEdit,
  onChanged,
  onOpen,
  onSetMain,
  onError,
  children,
}: {
  projectId: string
  tree: ProjectTree | null
  canEdit: boolean
  /** Recharge l'arborescence après une modification. */
  onChanged: () => Promise<void>
  /** Ouvre un document créé. */
  onOpen: (id: string) => void
  onSetMain: (documentId: string) => Promise<void>
  onError: (message: string) => void
  children: ReactNode
}) {
  const [dialog, setDialog] = useState<Dialog>(null)
  const [uploads, setUploads] = useState<string[]>([])
  const uploadInput = useRef<HTMLInputElement>(null)
  const uploadFolder = useRef<string | null>(null)

  const run = useCallback(
    async (action: () => Promise<unknown>) => {
      try {
        await action()
        await onChanged()
      } catch (caught) {
        onError(errorMessage(caught))
      }
    },
    [onChanged, onError],
  )

  const upload = useCallback(
    async (files: File[], folderId: string | null) => {
      if (files.length === 0) return
      setUploads((current) => [...current, ...files.map((file) => file.name)])
      for (const file of files) {
        try {
          await uploadToProject(projectId, file, folderId)
        } catch (caught) {
          onError(`${file.name} : ${errorMessage(caught)}`)
        } finally {
          setUploads((current) => current.filter((name) => name !== file.name))
        }
      }
      await onChanged()
    },
    [projectId, onChanged, onError],
  )

  const value = useMemo<FileActions>(
    () => ({
      canEdit,
      createDocument: (parentId) => {
        setDialog({ kind: 'create', entity: 'document', parentId })
      },
      createFolder: (parentId) => {
        setDialog({ kind: 'create', entity: 'folder', parentId })
      },
      chooseUploads: (folderId) => {
        uploadFolder.current = folderId
        uploadInput.current?.click()
      },
      upload,
      rename: (node) => {
        setDialog({ kind: 'rename', node })
      },
      remove: (node) => {
        setDialog({ kind: 'delete', node })
      },
      move: (type, id, folderId) => {
        if (tree === null) return
        if (type === 'folder' && folderId !== null && isInside(tree, folderId, id)) return
        void run(() => api.updateEntity(projectId, type, id, { folderId }))
      },
      setMain: (documentId) => {
        void run(() => onSetMain(documentId))
      },
      uploads,
    }),
    [canEdit, upload, tree, run, projectId, onSetMain, uploads],
  )

  return (
    <FileActionsContext value={value}>
      {children}
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
            await onChanged()
            onOpen(document.id)
            return
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
          // Les onglets des entités supprimées se ferment au rechargement de l'arborescence.
          void run(() => api.deleteEntity(projectId, node.type, node.entity.id))
        }}
      />
    </FileActionsContext>
  )
}

/** Actions sur l'arborescence du projet ouvert (voir `FileActionsProvider`). */
export function useFileActions(): FileActions {
  const value = useContext(FileActionsContext)
  if (value === null) throw new Error('useFileActions must be used inside FileActionsProvider')
  return value
}
