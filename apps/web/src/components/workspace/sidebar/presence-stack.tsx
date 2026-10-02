'use client'

import { AvatarStack, type AvatarStackItem } from '@kaxolax/ui'

/**
 * Collaborateurs en ligne sur le projet (pile d'avatars de la sidebar). Emplacement de la tâche 5
 * (présence) : elle fournira les personnes connectées (awareness du document meta du projet), leur
 * fichier ouvert et le suivi au clic. Rien n'est affiché tant que la liste est vide.
 */
export function PresenceStack({
  people = [],
  onFollow,
}: {
  people?: readonly AvatarStackItem[]
  onFollow?: (person: AvatarStackItem) => void
}) {
  if (people.length === 0) return null
  return (
    <AvatarStack
      items={people}
      max={4}
      size="sm"
      onSelect={onFollow}
      overflowLabel={(count) => `${String(count)} autres personnes en ligne`}
      data-testid="presence-stack"
    />
  )
}
