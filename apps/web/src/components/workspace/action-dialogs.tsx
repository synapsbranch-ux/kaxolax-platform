import type { ActionContext } from '@kaxolax/editor'
import type { ComponentType } from 'react'

/** Propriétés d'une boîte de dialogue ouverte par une action (`host.openDialog(id, payload)`). */
export interface ActionDialogProps {
  /** Donnée transmise par l'action (formule sous le curseur, tableau existant…). */
  payload: unknown
  /** Contexte courant (éditeur ouvert, callbacks), à relire au moment d'insérer. */
  context: () => ActionContext
  onClose: () => void
}

/**
 * Boîtes de dialogue des outils, par identifiant (`math.formula`, `math.symbols`,
 * `structures.table`, `packages.manager`…). Vide à la tâche 3 : les outils d'écriture (tâches 9
 * et 10) y ajoutent leur composant et enregistrent l'action qui l'ouvre.
 */
export const ACTION_DIALOGS: Partial<Record<string, ComponentType<ActionDialogProps>>> = {}
