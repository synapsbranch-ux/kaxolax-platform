'use client'

import {
  type ActionContext,
  type ActionHost,
  type ActionRegistry,
  createDefaultRegistry,
  type PromptRequest,
} from '@kaxolax/editor'
import { createContext, type ReactNode, type RefObject, useContext, useMemo, useState } from 'react'
import { NameDialog } from '@/components/name-dialog'
import { ACTION_DIALOGS } from './action-dialogs'
import type { EditorHandle } from './editor/code-editor'
import { useFileActions } from './file-actions'

/**
 * Registre d'actions du projet ouvert et callbacks de l'application : c'est le point d'extension
 * des outils (barre Tools, raccourcis). Un outil s'enregistre avec
 * `useEffect(() => registry.register(action), [registry])` et, s'il a une boîte de dialogue,
 * l'ajoute à `ACTION_DIALOGS` (ouverte par `host.openDialog(id, payload)`).
 */
export interface EditorActions {
  registry: ActionRegistry
  host: ActionHost
  /** Contexte d'exécution courant : éditeur ouvert (null sinon) et callbacks. */
  context: () => ActionContext
  /** Exécute une action du registre dans le contexte courant. */
  run: (id: string) => boolean
}

const EditorActionsContext = createContext<EditorActions | null>(null)

interface OpenDialog {
  id: string
  payload: unknown
}

interface PendingPrompt {
  request: PromptRequest
  resolve: (value: string | null) => void
}

/**
 * Fournit le registre d'actions (actions de base de @kaxolax/editor) et les callbacks de
 * l'application : création et upload de fichiers (désactivés en lecture seule), compilation, zip,
 * recherche dans le projet, saisie d'un texte, boîtes de dialogue des outils et messages.
 */
export function WorkspaceActionsProvider({
  canEdit,
  compile,
  downloadZip,
  searchProject,
  notify,
  editor,
  children,
}: {
  canEdit: boolean
  compile: () => void
  downloadZip: () => void
  searchProject: (query: string) => void
  notify: NonNullable<ActionHost['notify']>
  /** Éditeur courant (null sans document ouvert). */
  editor: RefObject<EditorHandle | null>
  children: ReactNode
}) {
  const files = useFileActions()
  const [registry] = useState(createDefaultRegistry)
  const [dialog, setDialog] = useState<OpenDialog | null>(null)
  const [prompt, setPrompt] = useState<PendingPrompt | null>(null)

  const host = useMemo<ActionHost>(
    () => ({
      readOnly: !canEdit,
      compile,
      downloadZip,
      searchProject,
      notify,
      openDialog: (id, payload) => {
        if (ACTION_DIALOGS[id] === undefined) notify(`Outil indisponible : ${id}`, 'warning')
        else setDialog({ id, payload })
      },
      prompt: (request) =>
        new Promise<string | null>((resolve) => {
          setPrompt({ request, resolve })
        }),
      ...(canEdit
        ? {
            newFile: () => {
              files.createDocument(null)
            },
            newFolder: () => {
              files.createFolder(null)
            },
            upload: () => {
              files.chooseUploads(null)
            },
          }
        : {}),
    }),
    [canEdit, compile, downloadZip, searchProject, notify, files],
  )
  const context = useMemo(() => contextGetter(editor, host), [editor, host])

  const value = useMemo<EditorActions>(
    () => ({ registry, host, context, run: (id) => registry.run(id, context()) }),
    [registry, host, context],
  )

  const Dialog = dialog === null ? undefined : ACTION_DIALOGS[dialog.id]
  return (
    <EditorActionsContext value={value}>
      {children}
      {Dialog && dialog ? (
        <Dialog
          payload={dialog.payload}
          context={context}
          onClose={() => {
            setDialog(null)
          }}
        />
      ) : null}
      <NameDialog
        key={prompt?.request.title ?? 'prompt'}
        open={prompt !== null}
        title={prompt?.request.title ?? ''}
        label={prompt?.request.label ?? ''}
        initialValue={prompt?.request.defaultValue}
        submitLabel="Valider"
        onSubmit={async (text) => {
          prompt?.resolve(text)
          await Promise.resolve()
        }}
        onOpenChange={(open) => {
          if (open) return
          // Sans effet si la valeur a déjà été transmise (une promesse ne se résout qu'une fois).
          prompt?.resolve(null)
          setPrompt(null)
        }}
      />
    </EditorActionsContext>
  )
}

/** Contexte d'exécution lu à chaque appel : l'éditeur courant change avec l'onglet actif. */
function contextGetter(
  editor: RefObject<EditorHandle | null>,
  host: ActionHost,
): () => ActionContext {
  return () => ({ view: editor.current?.view ?? null, host })
}

/** Registre d'actions et callbacks du projet ouvert (voir `WorkspaceActionsProvider`). */
export function useEditorActions(): EditorActions {
  const value = useContext(EditorActionsContext)
  if (value === null)
    throw new Error('useEditorActions must be used inside WorkspaceActionsProvider')
  return value
}
