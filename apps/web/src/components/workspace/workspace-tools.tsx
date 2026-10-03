'use client'

import type { EditorView } from '@codemirror/view'
import type { ProjectIndex } from '@kaxolax/editor'
import { createContext, type ReactNode, useContext } from 'react'
import type { TreeDocument } from '@/lib/api'

/**
 * Données du projet ouvert utiles aux outils (gestionnaire de packages, compteur de mots,
 * correction d'un package introuvable depuis les logs), fournies par la page projet.
 */
export interface WorkspaceTools {
  projectId: string
  projectName: string
  /** Document principal (compilé), null s'il n'est pas choisi. */
  mainDocument: TreeDocument | null
  /** Document de l'onglet actif. */
  activeDocument: TreeDocument | null
  /** Documents texte du projet (fichiers `.md` à convertir, cibles). */
  documents: readonly TreeDocument[]
  /** Relit l'arborescence (après la création de fichiers par un outil). */
  refreshTree: () => Promise<void>
  canEdit: boolean
  /** Ouvre un document dans un onglet. */
  openDocument: (documentId: string) => void
  /**
   * Ouvre le document `path` (s'il ne l'est pas déjà) puis appelle `edit` avec son éditeur, une
   * fois le document chargé (`edit` rend vrai s'il a modifié le document). Résolu à faux si
   * l'ouverture échoue, est abandonnée ou dépasse le délai : `edit` n'est alors jamais appelé.
   */
  editDocument: (path: string, edit: (view: EditorView) => boolean) => Promise<boolean>
  /** Index du projet (packages du document principal quand le fichier ouvert n'a pas de préambule). */
  projectIndex: ProjectIndex
  /** Attend que les dernières frappes soient arrivées au serveur (avant un comptage). */
  flush: () => Promise<void>
}

const WorkspaceToolsContext = createContext<WorkspaceTools | null>(null)

export function WorkspaceToolsProvider({
  value,
  children,
}: {
  value: WorkspaceTools
  children: ReactNode
}) {
  return <WorkspaceToolsContext value={value}>{children}</WorkspaceToolsContext>
}

/** Données du projet ouvert pour les outils (voir `WorkspaceTools`). */
export function useWorkspaceTools(): WorkspaceTools {
  const value = useContext(WorkspaceToolsContext)
  if (value === null)
    throw new Error('useWorkspaceTools must be used inside WorkspaceToolsProvider')
  return value
}
