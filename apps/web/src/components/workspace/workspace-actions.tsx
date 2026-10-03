'use client'

import {
  type ActionContext,
  type ActionHost,
  type ActionRegistry,
  createDefaultRegistry,
  hasEditor,
  openSpellcheckMenu,
  type PromptRequest,
} from '@kaxolax/editor'
import {
  createContext,
  type ReactNode,
  type RefObject,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react'
import { NameDialog } from '@/components/name-dialog'
import { useSettings } from '@/components/preferences/settings-provider'
import { actionsReadOnly, type EditMode } from '@/lib/suggestions'
import type { WordCountPayload } from '@/lib/word-count'
import { ACTION_DIALOGS, WORD_COUNT_DIALOG } from './action-dialogs'
import type { EditorHandle } from './editor/code-editor'
import { useFileActions } from './file-actions'
import { type WorkspaceTools, WorkspaceToolsProvider } from './workspace-tools'

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
 * l'application : création et upload de fichiers (désactivés sans droit d'édition), compilation, zip,
 * recherche dans le projet, saisie d'un texte, boîtes de dialogue des outils et messages.
 */
export function WorkspaceActionsProvider({
  canEdit,
  editMode,
  compile,
  downloadZip,
  searchProject,
  notify,
  editor,
  tools,
  children,
}: {
  canEdit: boolean
  /**
   * Mode effectif de l'éditeur (`useEditMode`) : en Suggérer, les actions qui modifient le texte
   * restent disponibles même sans droit d'édition (relecteur), leurs modifications devenant des
   * suggestions. Fichiers et dossiers restent réservés à `canEdit`.
   */
  editMode: EditMode | null
  compile: () => void
  downloadZip: () => void
  searchProject: (query: string) => void
  notify: NonNullable<ActionHost['notify']>
  /** Éditeur courant (null sans document ouvert). */
  editor: RefObject<EditorHandle | null>
  /** Données du projet pour les outils (`useWorkspaceTools`), dialogues compris. */
  tools: WorkspaceTools
  children: ReactNode
}) {
  const files = useFileActions()
  const [registry] = useState(createDefaultRegistry)
  const [dialog, setDialog] = useState<OpenDialog | null>(null)
  const [prompt, setPrompt] = useState<PendingPrompt | null>(null)
  const { openSettings } = useSettings()

  // Outils de l'application (tâche 10) : compteur de mots et paramètres (menu Fichier),
  // suggestions du correcteur pour le mot sous le curseur (menu Remplacer, F7).
  useEffect(
    () =>
      registry.register([
        {
          id: WORD_COUNT_DIALOG,
          label: 'Compteur de mots',
          menu: 'file',
          group: 'tools',
          icon: 'whole-word',
          when: (context) => context.host.openDialog !== undefined,
          run: (context) => {
            const payload: WordCountPayload = { kind: 'word-count' }
            context.host.openDialog?.(WORD_COUNT_DIALOG, payload)
            return true
          },
        },
        {
          id: 'file.settings',
          label: 'Paramètres de l’éditeur',
          menu: 'file',
          group: 'tools',
          icon: 'settings',
          run: () => {
            openSettings()
            return true
          },
        },
        {
          id: 'replace.spelling',
          label: 'Corriger l’orthographe du mot',
          menu: 'replace',
          group: 'spelling',
          icon: 'spell-check',
          shortcut: 'F7',
          when: hasEditor,
          run: (context) => (context.view === null ? false : openSpellcheckMenu(context.view)),
        },
      ]),
    [registry, openSettings],
  )

  const host = useMemo<ActionHost>(
    () => ({
      readOnly: actionsReadOnly(canEdit, editMode),
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
    [canEdit, editMode, compile, downloadZip, searchProject, notify, files],
  )
  const context = useMemo(() => contextGetter(editor, host), [editor, host])

  const value = useMemo<EditorActions>(
    () => ({ registry, host, context, run: (id) => registry.run(id, context()) }),
    [registry, host, context],
  )

  const Dialog = dialog === null ? undefined : ACTION_DIALOGS[dialog.id]
  return (
    <WorkspaceToolsProvider value={tools}>
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
    </WorkspaceToolsProvider>
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
