'use client'

import type { TemplateSummary } from '@kaxolax/contracts'
import { Badge, cn } from '@kaxolax/ui'
import { FileTextIcon } from 'lucide-react'
import Image from 'next/image'
import Link from 'next/link'
import { useState } from 'react'
import { CATEGORY_LABELS, templateHref } from '@/lib/templates'

/**
 * Miniature de la première page (PNG du catalogue, servi par le domaine public R2) : la place est
 * réservée avant le chargement (dimensions du catalogue). Sans URL ou en cas d'échec, un
 * cadre neutre la remplace.
 */
export function TemplateThumbnail({
  template,
  className,
  priority = false,
  natural = true,
}: {
  template: TemplateSummary
  className?: string
  priority?: boolean
  /** Proportions de la page (fiche) ; sinon le cadre de `className`, haut de page visible. */
  natural?: boolean
}) {
  const [failed, setFailed] = useState(false)
  const { url, width, height } = template.thumbnail
  return (
    <div
      className={cn('relative overflow-hidden bg-pdf-page', className)}
      style={natural ? { aspectRatio: `${String(width)} / ${String(height)}` } : undefined}
    >
      {url !== null && !failed ? (
        // Déjà à la bonne taille (600 px) : servie telle quelle, sans l'optimiseur de Next.js.
        <Image
          src={url}
          alt={`Première page du template « ${template.title} »`}
          width={width}
          height={height}
          unoptimized
          priority={priority}
          className="size-full object-cover object-top"
          onError={() => {
            setFailed(true)
          }}
        />
      ) : (
        <div
          className="flex size-full items-center justify-center text-pdf-muted-foreground"
          aria-hidden
        >
          <FileTextIcon className="size-10" />
        </div>
      )}
    </div>
  )
}

/**
 * Carte de la galerie : miniature, titre, catégorie et description. Lien vers la fiche du
 * template, ou bouton quand `onOpen` est fourni (galerie dans une boîte de dialogue).
 */
export function TemplateCard({
  template,
  onOpen,
  priority,
}: {
  template: TemplateSummary
  onOpen?: (template: TemplateSummary) => void
  priority?: boolean
}) {
  const content = (
    <>
      <TemplateThumbnail
        template={template}
        priority={priority}
        natural={false}
        className="aspect-[4/3] border-b transition-opacity group-hover:opacity-90"
      />
      <div className="flex flex-1 flex-col gap-1.5 p-3 text-left">
        <div className="flex items-start justify-between gap-2">
          <h3 className="font-medium leading-snug">{template.title}</h3>
          <Badge variant="secondary" className="shrink-0">
            {CATEGORY_LABELS[template.category]}
          </Badge>
        </div>
        <p className="line-clamp-3 text-sm text-muted-foreground">{template.description}</p>
      </div>
    </>
  )
  const className =
    'group flex h-full w-full flex-col overflow-hidden rounded-lg border bg-card text-card-foreground shadow-xs outline-none transition-shadow hover:shadow-md focus-visible:ring-[3px] focus-visible:ring-ring/50'
  return onOpen ? (
    <button
      type="button"
      className={className}
      onClick={() => {
        onOpen(template)
      }}
      data-testid="template-card"
    >
      {content}
    </button>
  ) : (
    <Link href={templateHref(template.id)} className={className} data-testid="template-card">
      {content}
    </Link>
  )
}
