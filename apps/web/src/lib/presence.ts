import { parsePresenceState, type PresenceCursor, type PresenceUser } from '@kaxolax/contracts'
import * as Y from 'yjs'

/**
 * Logique de la présence côté navigateur, sans React : regroupement des états d'awareness par
 * personne, fichiers ouverts par les autres, suivi d'un collaborateur. Les états reçus sont
 * validés (`parsePresenceState`) : un état mal formé est ignoré.
 */

/** Un collaborateur en ligne, toutes ses connexions (onglets) regroupées. */
export interface OnlinePerson {
  user: PresenceUser
  /**
   * Fichiers ouverts (onglet actif de chaque connexion), sans doublon, dans l'ordre des clientIds
   * Yjs ; le premier sert au suivi.
   */
  documentIds: string[]
}

/**
 * Personnes en ligne d'après l'awareness du document meta : un élément par utilisateur (plusieurs
 * onglets regroupés), soi-même exclu (`selfUserId`, tous ses onglets), triées par nom puis par id.
 */
export function groupPresence(
  states: ReadonlyMap<number, unknown>,
  selfUserId: string | null,
): OnlinePerson[] {
  const people = new Map<string, OnlinePerson>()
  const clientIds = [...states.keys()].sort((a, b) => a - b)
  for (const clientId of clientIds) {
    const state = parsePresenceState(states.get(clientId))
    if (state === null || state.user.id === selfUserId) continue
    const person = people.get(state.user.id) ?? { user: state.user, documentIds: [] }
    const documentId = state.documentId ?? null
    if (documentId !== null && !person.documentIds.includes(documentId))
      person.documentIds.push(documentId)
    people.set(state.user.id, person)
  }
  return [...people.values()].sort(
    (a, b) => a.user.name.localeCompare(b.user.name, 'fr') || a.user.id.localeCompare(b.user.id),
  )
}

/** Personnes qui ont chaque fichier ouvert (pastilles de l'arborescence). */
export function peopleByDocument(people: readonly OnlinePerson[]): Map<string, PresenceUser[]> {
  const result = new Map<string, PresenceUser[]>()
  for (const person of people) {
    for (const documentId of person.documentIds) {
      const list = result.get(documentId) ?? []
      list.push(person.user)
      result.set(documentId, list)
    }
  }
  return result
}

/** Description du survol d'un avatar : le fichier ouvert (noms résolus par `nameOf`). */
export function presenceDescription(
  person: OnlinePerson,
  nameOf: (id: string) => string | null,
): string {
  const names = person.documentIds
    .map(nameOf)
    .filter((name): name is string => name !== null && name !== '')
  if (names.length === 0) return 'Aucun fichier ouvert'
  return names.length === 1 ? `Sur ${names[0] ?? ''}` : `Sur ${names.join(', ')}`
}

/** Collaborateur suivi (clic sur son avatar) ; null : aucun suivi. */
export interface FollowTarget {
  userId: string
  name: string
}

/**
 * Prochaine étape du suivi, d'après la présence courante :
 * - `stop` : la personne n'est plus en ligne ;
 * - `open` : elle est sur un autre fichier, qu'il faut ouvrir ;
 * - `stay` : rien à faire (même fichier, ou aucun fichier ouvert de son côté).
 */
export type FollowStep =
  { kind: 'stop'; reason: 'offline' } | { kind: 'open'; documentId: string } | { kind: 'stay' }

export function nextFollowStep(
  target: FollowTarget,
  people: readonly OnlinePerson[],
  activeId: string | null,
  exists: (id: string) => boolean,
): FollowStep {
  const person = people.find((candidate) => candidate.user.id === target.userId)
  if (!person) return { kind: 'stop', reason: 'offline' }
  // Déjà sur l'un de ses fichiers (plusieurs onglets) : on ne bouge pas.
  if (activeId !== null && person.documentIds.includes(activeId)) return { kind: 'stay' }
  const documentId = person.documentIds.find(exists)
  return documentId === undefined ? { kind: 'stay' } : { kind: 'open', documentId }
}

/**
 * Position (index dans le texte) du curseur d'un collaborateur dans un document texte, d'après
 * l'awareness de ce document : null s'il n'y a pas de curseur, ou si sa position ne désigne pas
 * `ytext`. Avec plusieurs onglets sur le même document, le premier clientId qui a un curseur.
 */
export function cursorIndexOf(
  states: ReadonlyMap<number, unknown>,
  userId: string,
  ytext: Y.Text,
): number | null {
  const doc = ytext.doc
  if (doc === null) return null
  const clientIds = [...states.keys()].sort((a, b) => a - b)
  for (const clientId of clientIds) {
    const state = parsePresenceState(states.get(clientId))
    if (state?.user.id !== userId || !state.cursor) continue
    const index = absoluteIndex(state.cursor, ytext, doc)
    if (index !== null) return index
  }
  return null
}

function absoluteIndex(cursor: PresenceCursor, ytext: Y.Text, doc: Y.Doc): number | null {
  try {
    const head = Y.createAbsolutePositionFromRelativePosition(
      Y.createRelativePositionFromJSON(cursor.head),
      doc,
    )
    return head !== null && head.type === ytext ? head.index : null
  } catch {
    // Position mal formée (état d'un autre client) : ignorée.
    return null
  }
}
