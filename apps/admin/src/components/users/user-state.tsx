import { Badge } from '@kaxolax/ui'

/** État d'un compte : supprimé, banni ou actif. */
export function UserState({
  bannedAt,
  deletedAt,
}: {
  bannedAt: string | null
  deletedAt: string | null
}) {
  if (deletedAt !== null) return <Badge variant="secondary">Supprimé</Badge>
  if (bannedAt !== null) return <Badge variant="destructive">Banni</Badge>
  return <Badge variant="outline">Actif</Badge>
}
