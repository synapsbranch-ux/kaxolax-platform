import { Badge } from '@kaxolax/ui'

/** État d'un projet : corbeille, archivé ou actif. */
export function ProjectState({
  archivedAt,
  trashedAt,
}: {
  archivedAt: string | null
  trashedAt: string | null
}) {
  if (trashedAt !== null) return <Badge variant="destructive">Corbeille</Badge>
  if (archivedAt !== null) return <Badge variant="secondary">Archivé</Badge>
  return <Badge variant="outline">Actif</Badge>
}
