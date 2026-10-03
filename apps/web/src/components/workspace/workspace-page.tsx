'use client'

import type { EditorView } from '@codemirror/view'
import {
  canComment as canCommentRole,
  type Compiler,
  type CompileResult,
  type LogEntry,
  type PdfPosition,
  presenceUserFor,
  type ProjectSearchMatch,
  type SpellcheckLanguage,
} from '@kaxolax/contracts'
import { type ActionHost, editorSettings } from '@kaxolax/editor'
import { Alert, Button, Skeleton } from '@kaxolax/ui'
import { useRouter } from 'next/navigation'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useRequiredUser } from '@/components/auth/session'
import { usePreferences } from '@/components/preferences/preferences-provider'
import {
  type ProjectSettings,
  useProjectSettings,
  useSettings,
} from '@/components/preferences/settings-provider'
import { api, ApiError, errorMessage, type Project, type ProjectTree } from '@/lib/api'
import {
  closeTab,
  EMPTY_TABS,
  openTab,
  pruneTabs,
  restoreTabs,
  type TabsState,
  tabsEntry,
} from '@/lib/preferences'
import { dictionaryAddRefusal, isSpellcheckedPath } from '@/lib/editor-settings'
import {
  type FollowTarget,
  nextFollowStep,
  type OnlinePerson,
  peopleByDocument,
} from '@/lib/presence'
import { type MissingPackage, planRenamePackage } from '@/lib/package-tools'
import { PackageNameCache } from '@/lib/package-names'
import {
  bannerFeed,
  chatFeed,
  commentFeed,
  eventEffect,
  historyFeed,
  type RealtimeMessage,
} from '@/lib/project-events'
import { ROLE_DESCRIPTIONS, ROLE_LABELS } from '@/lib/sharing'
import { documentByPath } from '@/lib/tree'
import { WORD_COUNT_DIALOG } from './action-dialogs'
import type { EditorHandle, SyncState } from './editor/code-editor'
import { EditorColumn } from './editor/editor-column'
import type { OpenTab } from './editor/editor-tabs'
import { texlivePackageNames } from './editor/package-name-completion'
import { EditorStatusBar } from './editor/status-bar'
import { FileActionsProvider } from './file-actions'
import type { CompileSettings } from './pdf/compile-status'
import { PdfColumn } from './pdf/pdf-column'
import { OutlineTree } from './sidebar/outline-tree'
import { Sidebar, type SidebarTab } from './sidebar/sidebar'
import { useProjectChat } from './use-project-chat'
import { SpellcheckMenu } from './spellcheck/spellcheck-menu'
import { useSpellcheck } from './spellcheck/use-spellcheck'
import { useCompile } from './use-compile'
import { useDocumentOutline } from './use-outline'
import { useProjectIndex } from './use-project-index'
import { useProjectMeta } from './use-project-meta'
import { useRealtimeSocket } from './use-realtime'
import { useEditorActions, WorkspaceActionsProvider } from './workspace-actions'
import type { WorkspaceTools } from './workspace-tools'
import { type NarrowView, WorkspaceLayout } from './workspace-layout'

/** Durée d'affichage d'un message court (actions de la barre Tools). */
const NOTICE_MS = 5_000
/** Regroupement des relectures de l'arborescence (rafale d'événements : upload, import). */
const TREE_REFRESH_DELAY_MS = 150
/** Délai avant le retour au tableau de bord d'un membre retiré. */
const REMOVED_REDIRECT_MS = 6_000
/**
 * Absence tolérée d'un collaborateur suivi avant d'arrêter le suivi : une reconnexion (coupure
 * brève, redéploiement) efface puis rétablit la présence en quelques centaines de ms.
 */
const FOLLOW_GRACE_MS = 3_000
/** Attente maximale de l'ouverture d'un document à modifier (correction depuis les logs). */
const EDIT_DOCUMENT_TIMEOUT_MS = 15_000

/**
 * Page projet : charge le projet, l'arborescence et la dernière compilation, tient les onglets
 * ouverts (mémorisés par projet dans les préférences), la compilation et SyncTeX, et compose la
 * sidebar, l'éditeur et le PDF dans `WorkspaceLayout`.
 */
export function WorkspacePage({ projectId }: { projectId: string }) {
  const user = useRequiredUser()
  const { preferences, loaded: preferencesLoaded, update: updatePreferences } = usePreferences()
  const [project, setProject] = useState<Project | null>(null)
  const [tree, setTree] = useState<ProjectTree | null>(null)
  // Dernière compilation lue au chargement, avec sa date de réception (liens présignés datés).
  const [lastCompile, setLastCompile] = useState<{
    result: CompileResult | null
    receivedAt: number
  }>({ result: null, receivedAt: 0 })
  const [notFound, setNotFound] = useState(false)
  // Échec du chargement initial (réseau, API) : page d'erreur avec nouvel essai.
  const [loadError, setLoadError] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<{ message: string; level: string } | null>(null)
  const [tabs, setTabs] = useState<TabsState | null>(null)
  const [syncState, setSyncState] = useState<SyncState>('connecting')
  const [highlight, setHighlight] = useState<PdfPosition | null>(null)
  const [narrowView, setNarrowView] = useState<NarrowView>('editor')
  const [search, setSearch] = useState<{ query: string; serial: number } | null>(null)
  // Demandes d'affichage de la sidebar (repliée ou en tiroir) : recherche dans le projet.
  const [revealSidebar, setRevealSidebar] = useState(0)
  // Navigations vers un fichier (arbre, plan, recherche, logs) : le tiroir de la sidebar se ferme.
  const [navigations, setNavigations] = useState(0)
  // `?panel=chat` (lien de l'email de mention) : sidebar affichée sur l'onglet Chats.
  const [chatLink] = useState(
    () =>
      typeof window !== 'undefined' &&
      new URLSearchParams(window.location.search).get('panel') === 'chat',
  )
  const [sidebarTab, setSidebarTab] = useState<SidebarTab>(chatLink ? 'chats' : 'files')
  // Sidebar réellement visible : le chat n'est marqué comme lu que s'il est sous les yeux.
  const [sidebarShown, setSidebarShown] = useState(false)
  const showEditor = useCallback(() => {
    setNarrowView('editor')
    setNavigations((count) => count + 1)
  }, [])
  const editor = useRef<EditorHandle | null>(null)
  // Éditeur courant, aussi en état : le plan du document se met à jour quand il change.
  const [editorHandle, setEditorHandle] = useState<EditorHandle | null>(null)
  // Position à atteindre une fois le document visé ouvert (log, SyncTeX, plan, recherche) : elle ne
  // s'applique qu'à l'éditeur de ce document.
  // `then` : action à faire dans ce document une fois ouvert (correction d'un package) ;
  // `cancel` : prévient cette action quand elle est abandonnée (autre navigation entre-temps).
  const pendingTarget = useRef<{
    documentId: string
    target: Target | null
    then?: (handle: EditorHandle) => void
    cancel?: () => void
  } | null>(null)
  const { socket, error: socketError } = useRealtimeSocket(projectId)
  const router = useRouter()
  // Accès retiré pendant la session (membre retiré, départ depuis un autre onglet).
  const [removed, setRemoved] = useState(false)
  // Collaborateur suivi (clic sur son avatar), jusqu'à la prochaine frappe.
  const [following, setFollowing] = useState<(FollowTarget & { color: string }) | null>(null)
  // Incrémenté à chaque événement de membre : la modale de partage ouverte se relit.
  const [membersVersion, setMembersVersion] = useState(0)
  const self = useMemo(
    // Jamais l'email : la présence est visible de tous les membres du projet.
    () => (user ? presenceUserFor(user.id, user.fullName, user.avatarUrl) : null),
    [user],
  )

  const canEdit = project?.role === 'owner' || project?.role === 'editor'
  // Chat lu seulement s'il est affiché : sidebar visible, onglet Chats, sans recherche par-dessus.
  const chat = useProjectChat(
    project?.id ?? null,
    sidebarShown && sidebarTab === 'chats' && search === null,
  )

  const compileState = useCompile({
    projectId,
    flush: async () => {
      await editor.current?.flush()
    },
    options: preferences.compile,
    warm: canEdit,
    onError: setError,
  })
  const { compile, onBuildEvent } = compileState
  const result = compileState.result ?? lastCompile.result
  const resultReceivedAt =
    compileState.result !== null ? compileState.receivedAt : lastCompile.receivedAt

  // Relectures concurrentes (événement `tree.changed`, action locale) : seule la réponse de la
  // dernière demande s'applique, une réponse plus ancienne arrivée après est ignorée.
  const treeRequest = useRef(0)
  const refreshTree = useCallback(async () => {
    const request = ++treeRequest.current
    const next = await api.tree(projectId)
    if (request !== treeRequest.current) return
    setTree(next)
    setProject((current) =>
      current ? { ...current, mainDocumentId: next.mainDocumentId } : current,
    )
  }, [projectId])

  // Arborescence modifiée ailleurs (événement `tree.changed`) : relue une fois par rafale.
  const treeRefreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const scheduleTreeRefresh = useCallback(() => {
    if (treeRefreshTimer.current !== null) clearTimeout(treeRefreshTimer.current)
    treeRefreshTimer.current = setTimeout(() => {
      treeRefreshTimer.current = null
      refreshTree().catch(() => undefined)
    }, TREE_REFRESH_DELAY_MS)
  }, [refreshTree])
  useEffect(
    () => () => {
      if (treeRefreshTimer.current !== null) clearTimeout(treeRefreshTimer.current)
    },
    [],
  )

  /**
   * Relit le projet après un changement d'accès (rôle, retrait) : 404, l'utilisateur n'est plus
   * membre ; sinon le rôle relu bascule l'éditeur en lecture seule ou en écriture. Résolu à faux
   * seulement si l'accès est perdu (une erreur réseau laisse supposer qu'il reste membre).
   */
  const checkingAccess = useRef<Promise<boolean> | null>(null)
  const checkAccess = useCallback((): Promise<boolean> => {
    checkingAccess.current ??= api.project(projectId).then(
      ({ project: loaded }) => {
        checkingAccess.current = null
        setProject(loaded)
        return true
      },
      (caught: unknown) => {
        checkingAccess.current = null
        if (caught instanceof ApiError && caught.status === 404) {
          setRemoved(true)
          return false
        }
        return true
      },
    )
    return checkingAccess.current
  }, [projectId])

  // Membre retiré : message, puis retour au tableau de bord.
  useEffect(() => {
    if (!removed) return
    const timer = setTimeout(() => {
      router.push('/dashboard')
    }, REMOVED_REDIRECT_MS)
    return () => {
      clearTimeout(timer)
    }
  }, [removed, router])

  // Chargement : projet, arbre et dernière compilation (le PDF s'affiche dès l'ouverture).
  useEffect(() => {
    if (!user) return
    // Objet plutôt que variable : TypeScript ne garde pas le rétrécissement après un await.
    const state = { active: true }
    void (async () => {
      try {
        const [{ project: loaded }, loadedTree, last] = await Promise.all([
          api.project(projectId),
          api.tree(projectId),
          api.lastCompile(projectId),
        ])
        if (!state.active) return
        setProject(loaded)
        setTree(loadedTree)
        setLastCompile({ result: last.compile, receivedAt: Date.now() })
      } catch (caught) {
        if (!state.active) return
        if (caught instanceof ApiError && caught.status === 404) setNotFound(true)
        else setLoadError(errorMessage(caught))
      }
    })()
    return () => {
      state.active = false
    }
  }, [user, projectId])

  // Onglets : ceux mémorisés dans les préférences (sinon le document principal) tant que
  // l'utilisateur n'y a pas touché, puis l'état local ; ceux des fichiers supprimés disparaissent.
  const exists = useCallback(
    (id: string) =>
      tree !== null &&
      (tree.documents.some((document) => document.id === id) ||
        tree.files.some((file) => file.id === id)),
    [tree],
  )
  const savedTabs = preferences.openTabs[projectId]
  const currentTabs = useMemo<TabsState | null>(() => {
    if (tree === null || !preferencesLoaded) return null
    if (tabs !== null) return pruneTabs(tabs, exists)
    return restoreTabs(savedTabs, exists, tree.mainDocumentId ?? tree.documents[0]?.id ?? null)
  }, [tree, preferencesLoaded, tabs, savedTabs, exists])

  /** Change les onglets et les mémorise (préférences, envoi groupé). */
  const changeTabs = useCallback(
    (change: (current: TabsState) => TabsState) => {
      const current = currentTabs ?? EMPTY_TABS
      const next = change(current)
      if (next === current) return
      setTabs(next)
      updatePreferences({ openTabs: { [projectId]: tabsEntry(next) } })
    },
    [currentTabs, projectId, updatePreferences],
  )
  const open = useCallback(
    (id: string) => {
      changeTabs((current) => openTab(current, id))
      showEditor()
    },
    [changeTabs, showEditor],
  )

  const activeId = currentTabs?.active ?? null
  const activeDocument = tree?.documents.find((document) => document.id === activeId) ?? null
  const activeFile = tree?.files.find((file) => file.id === activeId) ?? null
  const openTabs = useMemo<OpenTab[]>(
    () =>
      (currentTabs?.ids ?? []).flatMap((id): OpenTab[] => {
        const document = tree?.documents.find((candidate) => candidate.id === id)
        if (document) return [{ id, name: document.name, path: document.path, kind: 'document' }]
        const file = tree?.files.find((candidate) => candidate.id === id)
        return file
          ? [{ id, name: file.name, path: file.path, kind: 'file', mimeType: file.mimeType }]
          : []
      }),
    [currentTabs, tree],
  )
  const activeTab = openTabs.find((tab) => tab.id === activeId) ?? null

  /** Message sans état du temps réel : événement du projet ou changement de son rôle. */
  const onRealtimeMessage = useCallback(
    (message: RealtimeMessage) => {
      if (message.kind === 'role') {
        setProject((current) => (current ? { ...current, role: message.message.role } : current))
        setNotice({
          message: `Votre rôle est maintenant ${ROLE_LABELS[message.message.role].toLowerCase()} (${ROLE_DESCRIPTIONS[message.message.role]})${message.message.readOnly ? ' : éditeur en lecture seule.' : '.'}`,
          level: 'info',
        })
        return
      }
      // Compilation asynchrone : l'état de la compilation suivie avance (pastille, résultat).
      if (message.event.type === 'compile.updated') {
        onBuildEvent(message.event)
        return
      }
      const effect = eventEffect(message.event, user?.id ?? null)
      switch (effect.kind) {
        case 'refresh-tree':
          scheduleTreeRefresh()
          break
        case 'refresh-members':
          setMembersVersion((version) => version + 1)
          break
        case 'refresh-access':
          setMembersVersion((version) => version + 1)
          void checkAccess()
          break
        case 'banners':
          bannerFeed.publish(effect.banners)
          break
        case 'chat':
          chatFeed.publish(effect.event)
          break
        case 'comment':
          commentFeed.publish(effect.event)
          break
        case 'history':
          historyFeed.publish(effect.event)
          break
        case 'project':
          setProject((current) => (current ? { ...current, ...effect.changes } : current))
          break
        case 'none':
          break
      }
    },
    [user, scheduleTreeRefresh, checkAccess, onBuildEvent],
  )

  // Suivi en cours et dernière présence connue, lus quand le délai de grâce expire.
  const followingRef = useRef(following)
  const latestPeople = useRef<readonly OnlinePerson[]>([])
  const followLostTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    followingRef.current = following
  })
  const cancelFollowLost = useCallback(() => {
    if (followLostTimer.current !== null) clearTimeout(followLostTimer.current)
    followLostTimer.current = null
  }, [])
  useEffect(() => cancelFollowLost, [cancelFollowLost])

  /**
   * Applique le suivi d'après la présence : ouvre le fichier du collaborateur suivi. Une absence
   * n'arrête le suivi qu'après `FOLLOW_GRACE_MS` sans retour de la personne.
   */
  const applyFollow = useCallback(
    (target: FollowTarget, people: readonly OnlinePerson[]) => {
      latestPeople.current = people
      const step = nextFollowStep(target, people, activeId, exists)
      if (step.kind !== 'stop') cancelFollowLost()
      if (step.kind === 'stop') {
        if (followLostTimer.current !== null) return
        followLostTimer.current = setTimeout(() => {
          followLostTimer.current = null
          if (followingRef.current?.userId !== target.userId) return
          if (latestPeople.current.some((person) => person.user.id === target.userId)) return
          setFollowing(null)
          setNotice({
            message: `${target.name} n'est plus en ligne : suivi arrêté.`,
            level: 'info',
          })
        }, FOLLOW_GRACE_MS)
      } else if (step.kind === 'open') {
        changeTabs((current) => openTab(current, step.documentId))
        showEditor()
      }
    },
    [activeId, exists, changeTabs, showEditor, cancelFollowLost],
  )

  const { people } = useProjectMeta({
    projectId,
    socket,
    self,
    activeId,
    onMessage: onRealtimeMessage,
    onAccessLost: checkAccess,
    onPeopleChange: (next) => {
      latestPeople.current = next
      if (following) applyFollow(following, next)
    },
  })
  const presenceByDocument = useMemo(() => peopleByDocument(people), [people])
  const nameOf = useCallback(
    (id: string) =>
      tree?.documents.find((document) => document.id === id)?.name ??
      tree?.files.find((file) => file.id === id)?.name ??
      null,
    [tree],
  )
  const follow = useCallback(
    (person: OnlinePerson) => {
      const target = { userId: person.user.id, name: person.user.name, color: person.user.color }
      cancelFollowLost()
      setFollowing(target)
      applyFollow(target, people)
    },
    [applyFollow, people, cancelFollowLost],
  )
  const stopFollowing = useCallback(() => {
    cancelFollowLost()
    setFollowing(null)
  }, [cancelFollowLost])

  // Nouveau PDF : le surlignage SyncTeX précédent n'a plus de sens.
  const runCompile = useCallback(() => {
    setHighlight(null)
    void compile()
  }, [compile])
  // Auto-compilation après une pause de frappe : pas de version dans l'historique.
  const runAutoCompile = useCallback(() => {
    setHighlight(null)
    void compile('auto')
  }, [compile])

  /** Ouvre la recherche dans le projet (sidebar affichée), préremplie avec `query`. */
  const searchProject = useCallback((query: string) => {
    setSearch((current) => ({ query, serial: (current?.serial ?? 0) + 1 }))
    setRevealSidebar((count) => count + 1)
  }, [])

  // Ctrl+Entrée et Ctrl+Maj+F partout dans la page (l'éditeur a ses propres raccourcis, qui
  // marquent l'événement).
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || !(event.ctrlKey || event.metaKey)) return
      if (event.key === 'Enter') {
        event.preventDefault()
        runCompile()
      } else if (event.shiftKey && event.key.toLowerCase() === 'f') {
        event.preventDefault()
        searchProject('')
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [runCompile, searchProject])

  useEffect(() => {
    if (notice === null) return
    const timer = setTimeout(() => {
      setNotice(null)
    }, NOTICE_MS)
    return () => {
      clearTimeout(timer)
    }
  }, [notice])

  /**
   * Ouvre un document du projet (chemin) et place le curseur, ou sélectionne une occurrence ;
   * `then` est appelé avec son éditeur une fois le document chargé, `cancel` si une autre
   * navigation l'abandonne avant. Faux si le chemin n'est pas un document du projet.
   */
  const openTarget = useCallback(
    (
      file: string,
      target: Target | null,
      then?: (handle: EditorHandle) => void,
      cancel?: () => void,
    ): boolean => {
      if (!tree) return false
      const document = documentByPath(tree, file)
      if (!document) {
        setError(`${file} n'est pas un document du projet.`)
        return false
      }
      showEditor()
      const previous = pendingTarget.current
      if (activeId === document.id && editor.current?.documentId === document.id) {
        if (previous !== null) {
          pendingTarget.current = null
          previous.cancel?.()
        }
        if (target !== null) goTo(editor.current, target)
        then?.(editor.current)
      } else {
        pendingTarget.current = { documentId: document.id, target, then, cancel }
        previous?.cancel?.()
        changeTabs((current) => openTab(current, document.id))
      }
      return true
    },
    [tree, activeId, changeTabs, showEditor],
  )
  const openLocation = useCallback(
    (file: string, line: number) => {
      openTarget(file, { line })
    },
    [openTarget],
  )
  const openMatch = useCallback(
    (match: ProjectSearchMatch) => {
      openTarget(match.path, match)
    },
    [openTarget],
  )

  const onEditorReady = useCallback((handle: EditorHandle | null) => {
    editor.current = handle
    setEditorHandle(handle)
    const pending = pendingTarget.current
    if (handle === null || pending === null) return
    // Un autre document activé entre-temps abandonne la position visée.
    pendingTarget.current = null
    if (handle.documentId === pending.documentId) {
      if (pending.target !== null) goTo(handle, pending.target)
      pending.then?.(handle)
    } else {
      pending.cancel?.()
    }
  }, [])

  const outline = useDocumentOutline({
    projectId,
    socket,
    tree,
    mainDocumentId: project?.mainDocumentId ?? null,
    document: activeDocument,
    editor: editorHandle,
  })

  // Autocomplétion : index de tout le projet, et noms de packages de TeX Live appris à la frappe.
  const projectIndex = useProjectIndex({
    projectId,
    socket,
    tree,
    mainDocumentId: project?.mainDocumentId ?? null,
    document: activeDocument,
    editor: editorHandle,
  })
  const [packageNames] = useState(() => new PackageNameCache())
  const editorExtensions = useMemo(
    () => texlivePackageNames(projectIndex, packageNames),
    [projectIndex, packageNames],
  )
  const activePath = useRef<string | null>(null)
  useEffect(() => {
    activePath.current = activeDocument?.path ?? null
  })
  const completion = useMemo(
    () => ({ sources: () => projectIndex, currentFile: () => activePath.current }),
    [projectIndex],
  )

  // Correcteur (worker chargé à la première activation) et paramètres de l'éditeur.
  const spellcheckLanguage: SpellcheckLanguage = project?.spellcheckLanguage ?? 'en'
  const spellcheck = useSpellcheck({
    // Seulement pour la prose (.tex, .ltx, .txt) : pas de soulignements dans un .bib ou un .sty.
    enabled:
      preferences.editor.spellcheck &&
      activeDocument !== null &&
      isSpellcheckedPath(activeDocument.path),
    language: spellcheckLanguage,
    dictionary: preferences.spellcheckDictionary,
    onDictionaryChange: (words) => {
      updatePreferences({ spellcheckDictionary: words })
    },
  })
  const editorPreferences = preferences.editor
  const editorConfig = useMemo(
    () => editorSettings(editorPreferences, preferences.theme, spellcheck.config),
    [editorPreferences, preferences.theme, spellcheck.config],
  )
  const { openSettings } = useSettings()
  // Lectures des réglages de l'IA stables tant que projet et workspace ne changent pas : un
  // renommage ou un changement de langue ne relance pas la lecture (ProjectAiSetting).
  const workspaceId = project?.workspaceId ?? null
  const loadAiSettings = useCallback(() => api.projectAi(projectId), [projectId])
  const loadWorkspaceAiSettings = useCallback(
    () =>
      workspaceId === null
        ? Promise.reject(new Error('Workspace unknown'))
        : api.workspaceAi(workspaceId),
    [workspaceId],
  )
  const projectSettings = useMemo<ProjectSettings | null>(
    () =>
      project === null
        ? null
        : {
            projectName: project.name,
            spellcheckLanguage: project.spellcheckLanguage,
            canEdit,
            onSpellcheckLanguageChange: async (language) => {
              setProject(
                (await api.updateProject(projectId, { spellcheckLanguage: language })).project,
              )
            },
            loadAiSettings,
            onAiEnabledChange: async (enabled) => {
              const settings = await api.updateProjectAi(projectId, enabled)
              setProject((current) =>
                current === null ? current : { ...current, aiEnabled: settings.projectEnabled },
              )
              return settings
            },
            loadWorkspaceAiSettings,
            onWorkspaceAiEnabledChange: (enabled) =>
              api.updateWorkspaceAi(project.workspaceId, enabled),
          },
    [project, canEdit, projectId, loadAiSettings, loadWorkspaceAiSettings],
  )
  useProjectSettings(projectSettings)

  /**
   * Ouvre `path` puis appelle `edit` avec son éditeur, une fois le document chargé. Résolu à vrai
   * si `edit` a modifié le document ; à faux si le chemin n'est pas un document du projet, si une
   * autre navigation abandonne l'ouverture, ou au bout de `EDIT_DOCUMENT_TIMEOUT_MS` : `edit`
   * n'est alors plus jamais appelé (rien ne change dans le document après un échec annoncé).
   */
  const editDocument = useCallback(
    (path: string, edit: (view: EditorView) => boolean) =>
      new Promise<boolean>((resolve) => {
        let settled = false
        const settle = (applied: boolean) => {
          settled = true
          clearTimeout(timer)
          resolve(applied)
        }
        const then = (handle: EditorHandle) => {
          if (!settled) settle(edit(handle.view))
        }
        const timer = setTimeout(() => {
          if (settled) return
          if (pendingTarget.current?.then === then) pendingTarget.current = null
          settle(false)
        }, EDIT_DOCUMENT_TIMEOUT_MS)
        const opened = openTarget(path, null, then, () => {
          if (!settled) settle(false)
        })
        // Chemin inconnu : ni `then` ni `cancel` n'ont été appelés.
        if (!opened) settle(false)
      }),
    [openTarget],
  )

  /**
   * Corrige un package introuvable : dans le fichier du log (sinon le document principal), le
   * nom fautif du `\usepackage` (ou de la classe) est remplacé par la suggestion choisie.
   */
  const fixPackage = useCallback(
    async (entry: LogEntry, missing: MissingPackage, replacement: string) => {
      const main = tree?.documents.find((document) => document.id === project?.mainDocumentId)
      const path = [entry.file, main?.path].find(
        (candidate): candidate is string =>
          candidate !== null &&
          candidate !== undefined &&
          tree !== null &&
          documentByPath(tree, candidate) !== undefined,
      )
      if (path === undefined) return false
      return editDocument(path, (view) => {
        const plan = planRenamePackage(
          view.state.doc.toString(),
          missing.kind,
          missing.name,
          replacement,
          path === entry.file ? entry.line : null,
        )
        if (plan === null || view.state.readOnly) return false
        view.dispatch({
          changes: { from: plan.from, to: plan.to, insert: plan.insert },
          selection: { anchor: plan.from, head: plan.from + plan.insert.length },
          scrollIntoView: true,
          userEvent: 'input.replace',
        })
        view.focus()
        return true
      })
    },
    [tree, project, editDocument],
  )

  const flushEditor = useCallback(async () => {
    await editor.current?.flush()
  }, [])
  const mainDocument =
    tree?.documents.find((document) => document.id === project?.mainDocumentId) ?? null
  const tools = useMemo<WorkspaceTools>(
    () => ({
      projectId,
      projectName: project?.name ?? '',
      mainDocument,
      activeDocument,
      canEdit,
      openDocument: open,
      editDocument,
      projectIndex,
      flush: flushEditor,
    }),
    [
      projectId,
      project?.name,
      mainDocument,
      activeDocument,
      canEdit,
      open,
      editDocument,
      projectIndex,
      flushEditor,
    ],
  )

  const codeToPdf = useCallback(async () => {
    if (!activeDocument || !editor.current) return
    try {
      const { pdf } = await api.synctexCode(
        projectId,
        activeDocument.path,
        editor.current.cursorLine(),
      )
      if (pdf[0]) {
        setHighlight({ ...pdf[0] })
        setNarrowView('pdf')
      } else setError('Aucune zone du PDF ne correspond à cette ligne.')
    } catch (caught) {
      setError(errorMessage(caught))
    }
  }, [activeDocument, projectId])

  const pdfToCode = useCallback(
    async (page: number, h: number, v: number) => {
      try {
        const { code } = await api.synctexPdf(projectId, page, h, v)
        if (code[0]) openLocation(code[0].file, code[0].line)
      } catch (caught) {
        setError(errorMessage(caught))
      }
    },
    [projectId, openLocation],
  )

  const changeCompiler = useCallback(
    async (compiler: Compiler) => {
      try {
        setProject((await api.updateProject(projectId, { compiler })).project)
      } catch (caught) {
        setError(errorMessage(caught))
      }
    },
    [projectId],
  )

  const downloadZip = useCallback(() => {
    // Lien signé de 60 s : une navigation ne porte pas le jeton Clerk.
    api.downloadUrl(projectId).then(
      ({ url }) => {
        window.location.assign(url)
      },
      (caught: unknown) => {
        setError(errorMessage(caught))
      },
    )
  }, [projectId])

  const notify = useCallback<NonNullable<ActionHost['notify']>>((message, level = 'info') => {
    if (level === 'error') setError(message)
    else setNotice({ message, level })
  }, [])

  const settings: CompileSettings = {
    compiler: project?.compiler ?? 'pdflatex',
    autoCompile: preferences.autoCompile,
    draft: preferences.compile.draft,
    haltOnFirstError: preferences.compile.haltOnFirstError,
  }

  if (removed) {
    return (
      <main className="flex min-h-screen flex-col items-center justify-center gap-3 px-4 text-center">
        <p className="text-lg font-semibold" role="alert">
          Vous n'avez plus accès à ce projet
        </p>
        <p className="max-w-md text-sm text-muted-foreground">
          Le propriétaire vous a retiré du projet, ou vous l'avez quitté depuis un autre onglet.
          Retour au tableau de bord dans quelques secondes.
        </p>
        <Button asChild>
          <a href="/dashboard">Retour aux projets</a>
        </Button>
      </main>
    )
  }

  if (notFound) {
    return (
      <main className="flex min-h-screen flex-col items-center justify-center gap-3">
        <p className="text-lg font-semibold">Projet introuvable</p>
        <Button asChild variant="outline">
          <a href="/dashboard">Retour aux projets</a>
        </Button>
      </main>
    )
  }

  if (loadError !== null) {
    return (
      <main className="flex min-h-screen flex-col items-center justify-center gap-3 px-4 text-center">
        <p className="text-lg font-semibold">Impossible d'ouvrir le projet</p>
        <p className="text-sm text-muted-foreground" role="alert">
          {loadError}
        </p>
        <div className="flex gap-2">
          <Button
            onClick={() => {
              window.location.reload()
            }}
          >
            Réessayer
          </Button>
          <Button asChild variant="outline">
            <a href="/dashboard">Retour aux projets</a>
          </Button>
        </div>
      </main>
    )
  }

  // Les tailles mémorisées des colonnes ne s'appliquent qu'au montage : on attend les préférences.
  if (!preferencesLoaded) {
    return (
      <div className="flex h-dvh">
        <Skeleton className="h-full w-[18%] rounded-none bg-sidebar" />
        <Skeleton className="h-full flex-1 rounded-none bg-editor" />
        <Skeleton className="h-full flex-1 rounded-none bg-pdf" />
      </div>
    )
  }

  return (
    <FileActionsProvider
      projectId={projectId}
      tree={tree}
      canEdit={canEdit}
      onChanged={refreshTree}
      onOpen={open}
      onSetMain={async (documentId) => {
        setProject((await api.updateProject(projectId, { mainDocumentId: documentId })).project)
      }}
      onError={setError}
    >
      <WorkspaceActionsProvider
        canEdit={canEdit}
        compile={runCompile}
        downloadZip={downloadZip}
        searchProject={searchProject}
        notify={notify}
        editor={editor}
        tools={tools}
      >
        <WorkspaceLayout
          layout={preferences.layout}
          onLayoutChange={updatePreferences}
          narrowView={narrowView}
          onNarrowViewChange={setNarrowView}
          revealSidebar={revealSidebar}
          dismissDrawer={navigations}
          openSidebarOnMount={chatLink}
          onSidebarShownChange={setSidebarShown}
          sidebarUnread={chat.unread > 0}
          sidebar={({ onCollapse, collapseLabel }) => (
            <Sidebar
              project={project}
              tree={tree}
              user={user}
              activeId={activeId}
              onOpen={open}
              onCollapse={onCollapse}
              collapseLabel={collapseLabel}
              search={search}
              onSearchProject={searchProject}
              onCloseSearch={() => {
                setSearch(null)
              }}
              onOpenMatch={openMatch}
              people={people}
              presenceByDocument={presenceByDocument}
              nameOf={nameOf}
              onFollow={follow}
              membersVersion={membersVersion}
              onAccessChanged={() => void checkAccess()}
              onOpenLocation={openLocation}
              tab={sidebarTab}
              onTabChange={setSidebarTab}
              chat={chat}
              outline={
                <OutlineTree
                  nodes={outline.nodes}
                  current={outline.current}
                  activePath={activeDocument?.path ?? null}
                  onSelect={openLocation}
                />
              }
            />
          )}
          editor={(leading) => (
            <EditorColumn
              projectId={projectId}
              tree={tree}
              tabs={openTabs}
              activeTab={activeTab}
              file={activeFile}
              socket={socket}
              connectionError={socketError}
              loading={currentTabs === null}
              canEdit={canEdit}
              canComment={project !== null && canCommentRole(project.role)}
              selfId={user?.id ?? null}
              membersVersion={membersVersion}
              settings={editorConfig}
              completion={completion}
              extensions={editorExtensions}
              statusBar={
                <EditorStatusBarSlot
                  editor={editorHandle}
                  documentOpen={activeDocument !== null}
                  keymap={editorConfig.keymap}
                  spellcheck={{
                    enabled: preferences.editor.spellcheck,
                    applies: activeDocument === null || isSpellcheckedPath(activeDocument.path),
                    language: spellcheckLanguage,
                    error: spellcheck.error,
                  }}
                  onSettings={openSettings}
                />
              }
              overlay={
                spellcheck.menu ? (
                  <SpellcheckMenu
                    key={`${String(spellcheck.menu.from)}:${spellcheck.menu.word}`}
                    menu={spellcheck.menu}
                    readOnly={!canEdit}
                    addRefusal={dictionaryAddRefusal(
                      preferences.spellcheckDictionary,
                      spellcheck.menu.word,
                    )}
                    onClose={spellcheck.closeMenu}
                    focusEditor={() => {
                      editor.current?.view.focus()
                    }}
                  />
                ) : null
              }
              autoCompile={preferences.autoCompile}
              toolsVisible={preferences.toolsVisible}
              syncState={syncState}
              leading={leading}
              self={self}
              following={following}
              onStopFollowing={stopFollowing}
              notice={
                <>
                  {error ? (
                    <Alert
                      variant="destructive"
                      className="rounded-none border-x-0 border-t-0 py-2"
                      data-testid="workspace-error"
                    >
                      {error}
                      <button
                        type="button"
                        className="ml-3 underline"
                        onClick={() => {
                          setError(null)
                        }}
                      >
                        Fermer
                      </button>
                    </Alert>
                  ) : null}
                  {notice ? (
                    <Alert className="rounded-none border-x-0 border-t-0 py-2" role="status">
                      {notice.message}
                    </Alert>
                  ) : null}
                </>
              }
              onActivate={open}
              onClose={(id) => {
                changeTabs((current) => closeTab(current, id))
              }}
              onToggleTools={() => {
                updatePreferences({ toolsVisible: !preferences.toolsVisible })
              }}
              onCompile={runCompile}
              onAutoCompile={runAutoCompile}
              onEditorReady={onEditorReady}
              onSyncState={setSyncState}
            />
          )}
          pdf={(leading) => (
            <PdfColumn
              result={result}
              resultReceivedAt={resultReceivedAt}
              compiling={compileState.compiling}
              phase={compileState.phase}
              settings={settings}
              canEdit={canEdit}
              fileName={`${project?.name ?? 'output'}.pdf`}
              highlight={highlight}
              canGoToPdf={activeDocument !== null}
              leading={leading}
              onCompile={runCompile}
              onStop={() => void compileState.stop()}
              onClearCache={compileState.clearCache}
              onSettingsChange={(change) => {
                if (change.compiler !== undefined) void changeCompiler(change.compiler)
                if (change.autoCompile !== undefined)
                  updatePreferences({ autoCompile: change.autoCompile })
                if (change.draft !== undefined || change.haltOnFirstError !== undefined)
                  updatePreferences({
                    compile: { draft: change.draft, haltOnFirstError: change.haltOnFirstError },
                  })
              }}
              onOpenLocation={openLocation}
              onFixPackage={canEdit ? fixPackage : undefined}
              onPdfDoubleClick={(page, h, v) => void pdfToCode(page, h, v)}
              onGoToPdf={() => void codeToPdf()}
              onUndo={() => editor.current?.undo()}
              onRedo={() => editor.current?.redo()}
              onDownloadZip={downloadZip}
              onRefreshOutputs={async () => (await api.lastCompile(projectId)).compile}
              onError={setError}
            />
          )}
        />
      </WorkspaceActionsProvider>
    </FileActionsProvider>
  )
}

/** Barre d'état : le compteur de mots passe par le registre d'actions (même boîte que le menu). */
function EditorStatusBarSlot(props: Omit<Parameters<typeof EditorStatusBar>[0], 'onWordCount'>) {
  const { run } = useEditorActions()
  return (
    <EditorStatusBar
      {...props}
      onWordCount={() => {
        run(WORD_COUNT_DIALOG)
      }}
    />
  )
}

/** Position à atteindre dans un document : ligne, ou occurrence (colonne et longueur). */
interface Target {
  line: number
  column?: number
  length?: number
}

function goTo(handle: EditorHandle, target: Target): void {
  if (target.column !== undefined && target.length !== undefined)
    handle.select(target.line, target.column, target.length)
  else handle.goToLine(target.line)
}
