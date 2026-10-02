'use client'

import { AvatarStack, type AvatarStackItem } from '@kaxolax/ui'
import { useMemo } from 'react'
import { type OnlinePerson, presenceDescription } from '@/lib/presence'

/**
 * Collaborateurs en ligne sur le projet (awareness du document meta), en pile d'avatars (photo de
 * profil, sinon initiales) dans leur couleur de présence. Au survol : le fichier où se trouve chacun ; un clic suit ce collaborateur
 * (son fichier s'ouvre et l'éditeur suit son curseur jusqu'à la prochaine frappe). Rien n'est
 * affiché quand personne d'autre n'est en ligne.
 */
export function PresenceStack({
  people,
  nameOf,
  onFollow,
}: {
  people: readonly OnlinePerson[]
  /** Nom d'un fichier du projet par son id (null : inconnu). */
  nameOf: (id: string) => string | null
  onFollow: (person: OnlinePerson) => void
}) {
  const items = useMemo<AvatarStackItem[]>(
    () =>
      people.map((person) => ({
        id: person.user.id,
        name: person.user.name,
        imageUrl: person.user.avatarUrl,
        color: person.user.color,
        description: presenceDescription(person, nameOf),
      })),
    [people, nameOf],
  )
  if (items.length === 0) return null
  return (
    <AvatarStack
      items={items}
      max={4}
      size="sm"
      aria-label={`${String(items.length)} ${items.length > 1 ? 'collaborateurs' : 'collaborateur'} en ligne ; cliquer pour suivre`}
      onSelect={(item) => {
        const person = people.find((candidate) => candidate.user.id === item.id)
        if (person) onFollow(person)
      }}
      overflowLabel={(count) => `${String(count)} autres personnes en ligne`}
      data-testid="presence-stack"
    />
  )
}
