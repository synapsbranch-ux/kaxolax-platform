import type { AdminPagination, BannerLevel } from '@kaxolax/contracts'
import { Alert, Badge, Button, cn } from '@kaxolax/ui'
import type { ReactNode } from 'react'

/** En-tête d'un écran : titre, description et actions. */
export function PageHeader({
  title,
  description,
  children,
}: {
  title: string
  description?: string
  children?: ReactNode
}) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
        {description ? <p className="mt-1 text-sm text-muted-foreground">{description}</p> : null}
      </div>
      {children ? <div className="flex flex-wrap items-center gap-2">{children}</div> : null}
    </div>
  )
}

export function ErrorAlert({ message }: { message: string | null }) {
  if (message === null) return null
  return (
    <Alert variant="destructive" className="mb-4">
      {message}
    </Alert>
  )
}

/** Tableau de données au style de l'admin. */
export function DataTable({ head, children }: { head: string[]; children: ReactNode }) {
  return (
    <div className="overflow-x-auto rounded-lg border bg-card">
      <table className="w-full text-left text-sm">
        <thead className="border-b text-xs uppercase tracking-wide text-muted-foreground">
          <tr>
            {head.map((label) => (
              <th key={label} scope="col" className="px-3 py-2 font-medium">
                {label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y">{children}</tbody>
      </table>
    </div>
  )
}

export function EmptyRow({ colSpan, loading }: { colSpan: number; loading: boolean }) {
  return (
    <tr>
      <td colSpan={colSpan} className="px-3 py-8 text-center text-muted-foreground">
        {loading ? 'Chargement…' : 'Aucun résultat.'}
      </td>
    </tr>
  )
}

/** Pagination d'une liste : précédent, suivant, position. */
export function Pager({
  pagination,
  onPage,
}: {
  pagination: AdminPagination | undefined
  onPage: (page: number) => void
}) {
  if (!pagination) return null
  const { page, lastPage, total } = pagination
  return (
    <div className="mt-3 flex items-center justify-between text-sm text-muted-foreground">
      <span>
        {total} résultat{total > 1 ? 's' : ''} · page {page} sur {lastPage}
      </span>
      <div className="flex gap-2">
        <Button
          variant="outline"
          size="sm"
          disabled={page <= 1}
          onClick={() => {
            onPage(page - 1)
          }}
        >
          Précédent
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={page >= lastPage}
          onClick={() => {
            onPage(page + 1)
          }}
        >
          Suivant
        </Button>
      </div>
    </div>
  )
}

/** Ligne libellé / valeur d'une fiche. */
export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[10rem_1fr] gap-2 py-1.5 text-sm">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words">{children}</dd>
    </div>
  )
}

export const BANNER_LEVEL_LABELS: Record<BannerLevel, string> = {
  info: 'Information',
  warning: 'Avertissement',
  maintenance: 'Maintenance',
}

const bannerLevelClasses: Record<BannerLevel, string> = {
  info: 'bg-banner-info text-white',
  warning: 'bg-banner-warning text-black',
  maintenance: 'bg-banner-maintenance text-white',
}

/** Bannière telle que l'affiche apps/web (aperçu dans l'admin). */
export function BannerPreview({ level, message }: { level: BannerLevel; message: string }) {
  return (
    <div
      className={cn(
        'rounded-md px-4 py-2 text-center text-sm font-medium',
        bannerLevelClasses[level],
      )}
    >
      {message.trim() === '' ? 'Votre message…' : message}
    </div>
  )
}

export function LevelBadge({ level }: { level: BannerLevel }) {
  return <Badge className={bannerLevelClasses[level]}>{BANNER_LEVEL_LABELS[level]}</Badge>
}
