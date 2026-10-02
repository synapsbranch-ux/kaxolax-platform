'use client'

import type { TemplateSummary } from '@kaxolax/contracts'
import { Badge, Button } from '@kaxolax/ui'
import { ExternalLinkIcon } from 'lucide-react'
import type { ReactNode } from 'react'
import { PdfViewer } from '@/components/workspace/pdf/pdf-viewer'
import { formatBytes } from '@/lib/plan-limits'
import { CATEGORY_LABELS, COMPILER_LABELS, LANGUAGE_LABELS } from '@/lib/templates'
import { TemplateThumbnail } from './template-card'

const ignore = () => undefined

/**
 * Aperçu PDF du template (pdf.js, comme la colonne PDF de l'éditeur), lu sur le domaine public
 * R2 du catalogue. Si le PDF ne peut pas être lu (CORS du bucket, réseau), la miniature reste
 * affichée avec un lien vers le PDF.
 */
function TemplatePreview({ template }: { template: TemplateSummary }) {
  const url = template.pdf.url
  if (url === null) {
    return (
      <div className="flex flex-col items-center gap-3 p-6">
        <TemplateThumbnail template={template} className="w-full max-w-sm shadow-md" priority />
        <p className="text-sm text-pdf-muted-foreground">Aperçu PDF indisponible.</p>
      </div>
    )
  }
  return (
    <PdfViewer
      url={url}
      zoom="page-width"
      highlight={null}
      onDoubleClick={ignore}
      onPageChange={ignore}
      errorActions={
        <Button asChild size="sm" variant="outline">
          <a href={url} target="_blank" rel="noopener noreferrer">
            <ExternalLinkIcon /> Ouvrir le PDF
          </a>
        </Button>
      }
    />
  )
}

/**
 * Fiche d'un template : aperçu PDF (colonne claire, comme dans l'éditeur), puis titre,
 * description, caractéristiques et action (`action` : « Utiliser ce template »). Deux colonnes à
 * partir de 1024 px, empilées en dessous.
 */
export function TemplateDetail({
  template,
  action,
  headingLevel = 1,
}: {
  template: TemplateSummary
  action: ReactNode
  /** Niveau du titre : 1 sur la page de la fiche, 2 dans une boîte de dialogue. */
  headingLevel?: 1 | 2
}) {
  const Heading = headingLevel === 1 ? 'h1' : 'h2'
  const facts: [string, string][] = [
    ['Catégorie', CATEGORY_LABELS[template.category]],
    ['Compilateur', COMPILER_LABELS[template.compiler]],
    ['Langue', LANGUAGE_LABELS[template.language]],
    ['Licence', template.license],
    ['Document principal', template.mainDocument],
    ['Taille des sources', formatBytes(template.zipBytes)],
  ]
  return (
    <div className="grid min-h-0 gap-6 lg:grid-cols-[minmax(0,3fr)_minmax(18rem,2fr)]">
      <section
        data-theme="light"
        aria-label={`Aperçu PDF de « ${template.title} »`}
        className="h-[min(70dvh,48rem)] min-h-80 overflow-hidden rounded-lg border border-pdf-border bg-pdf text-pdf-foreground lg:h-[calc(100dvh-12rem)]"
      >
        <TemplatePreview template={template} />
      </section>
      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-2">
          <Badge variant="secondary" className="self-start">
            {CATEGORY_LABELS[template.category]}
          </Badge>
          <Heading className="text-2xl font-semibold tracking-tight">{template.title}</Heading>
          <p className="text-muted-foreground">{template.description}</p>
        </div>
        <div>{action}</div>
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
          {facts.map(([label, value]) => (
            <div key={label} className="contents">
              <dt className="text-muted-foreground">{label}</dt>
              <dd className="min-w-0 break-words">{value}</dd>
            </div>
          ))}
        </dl>
        <ul className="flex flex-wrap gap-1.5" aria-label="Mots-clés">
          {template.tags.map((tag) => (
            <li key={tag}>
              <Badge variant="outline">{tag}</Badge>
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}
