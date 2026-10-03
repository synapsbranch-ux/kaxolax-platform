'use client'

import { PACKAGE_MANAGER_DIALOG, WRITING_DIALOGS, type ActionContext } from '@kaxolax/editor'
import {
  Alert,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@kaxolax/ui'
import { Component, type ComponentType, type ReactNode, useEffect, useState } from 'react'
import { ZOTERO_DIALOGS } from '@/lib/zotero'

/** Propriétés d'une boîte de dialogue ouverte par une action (`host.openDialog(id, payload)`). */
export interface ActionDialogProps {
  /** Donnée transmise par l'action (formule sous le curseur, tableau existant…). */
  payload: unknown
  /** Contexte courant (éditeur ouvert, callbacks), à relire au moment d'insérer. */
  context: () => ActionContext
  onClose: () => void
}

/**
 * Boîte affichée à la place d'un outil qui n'a pas pu être chargé ou qui a échoué : l'éditeur
 * reste ouvert (modifications non synchronisées gardées).
 */
function DialogFailure({ onClose, onRetry }: { onClose: () => void; onRetry?: () => void }) {
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Outil indisponible</DialogTitle>
          <DialogDescription>Votre document n’est pas affecté.</DialogDescription>
        </DialogHeader>
        <Alert variant="destructive">
          {onRetry
            ? 'L’outil n’a pas pu être chargé (connexion interrompue ou nouvelle version du site). Réessayez dans un instant.'
            : 'L’outil a rencontré une erreur et a été fermé.'}
        </Alert>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Fermer
          </Button>
          {onRetry ? <Button onClick={onRetry}>Réessayer</Button> : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** Erreur au rendu d'un outil : remplacée par `DialogFailure` au lieu de la page d'erreur. */
class DialogErrorBoundary extends Component<
  { onClose: () => void; children: ReactNode },
  { failed: boolean }
> {
  override state = { failed: false }

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true }
  }

  override render() {
    if (this.state.failed) return <DialogFailure onClose={this.props.onClose} />
    return this.props.children
  }
}

type DialogComponent = ComponentType<ActionDialogProps>

/**
 * Boîte de dialogue chargée à la première ouverture (module séparé, hors du bundle initial de la
 * page projet), jamais rendue côté serveur. Un chargement en échec (hors ligne, nouvelle version
 * déployée) affiche un message avec « Réessayer » au lieu de faire tomber la page.
 */
function lazyDialog(load: () => Promise<{ default: DialogComponent }>): DialogComponent {
  let loaded: DialogComponent | null = null
  let pending: Promise<DialogComponent> | null = null
  const fetchDialog = (): Promise<DialogComponent> => {
    pending ??= load().then(
      (module) => {
        loaded = module.default
        return module.default
      },
      (error: unknown) => {
        // Échec non mémorisé : « Réessayer » relance le chargement.
        pending = null
        throw error
      },
    )
    return pending
  }

  function LazyDialog(props: ActionDialogProps) {
    const [state, setState] = useState<{ component: DialogComponent } | 'loading' | 'error'>(() =>
      loaded === null ? 'loading' : { component: loaded },
    )
    const [attempt, setAttempt] = useState(0)
    useEffect(() => {
      if (loaded !== null) return
      let active = true
      fetchDialog().then(
        (component) => {
          if (active) setState({ component })
        },
        () => {
          if (active) setState('error')
        },
      )
      return () => {
        active = false
      }
    }, [attempt])

    if (state === 'loading') return null
    if (state === 'error') {
      return (
        <DialogFailure
          onClose={props.onClose}
          onRetry={() => {
            setState('loading')
            setAttempt((value) => value + 1)
          }}
        />
      )
    }
    const Loaded = state.component
    return (
      <DialogErrorBoundary onClose={props.onClose}>
        <Loaded {...props} />
      </DialogErrorBoundary>
    )
  }
  return LazyDialog
}

/** Boîte du compteur de mots (action `file.wordCount` de l'application). */
export const WORD_COUNT_DIALOG = 'file.wordCount'

/**
 * Boîtes de dialogue des outils, par identifiant d'action. Outils d'écriture (tâche 9) :
 * éditeur de formules (MathLive), symboles, tableaux ; tâche 10 : gestionnaire de packages et
 * compteur de mots.
 */
export const ACTION_DIALOGS: Partial<Record<string, DialogComponent>> = {
  [WRITING_DIALOGS.formula]: lazyDialog(() => import('./writing/formula-dialog')),
  [WRITING_DIALOGS.symbols]: lazyDialog(() => import('./writing/symbols-dialog')),
  [WRITING_DIALOGS.table]: lazyDialog(() => import('./writing/table-dialog')),
  [PACKAGE_MANAGER_DIALOG]: lazyDialog(() => import('./tools/package-manager-dialog')),
  [WORD_COUNT_DIALOG]: lazyDialog(() => import('./tools/word-count-dialog')),
  // Zotero (étape 3, tâche 9) : panneau du lien et sélecteur de citations.
  [ZOTERO_DIALOGS.panel]: lazyDialog(() => import('./tools/zotero-dialog')),
  [ZOTERO_DIALOGS.cite]: lazyDialog(() => import('./tools/zotero-citation-dialog')),
}
