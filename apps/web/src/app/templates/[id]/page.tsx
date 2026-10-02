import { auth } from '@clerk/nextjs/server'
import { Alert, Button } from '@kaxolax/ui'
import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { cache } from 'react'
import { GalleryShell } from '@/components/templates/gallery-shell'
import { TemplatePage } from '@/components/templates/template-page'
import { USE_TEMPLATE_PARAM } from '@/lib/templates'
import { fetchTemplate } from '@/lib/templates-server'

/** Une lecture par requête, partagée par les métadonnées et la page. */
const loadTemplate = cache(fetchTemplate)

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>
}): Promise<Metadata> {
  const template = await loadTemplate((await params).id)
  if (typeof template === 'string') return { title: 'Template — Kaxolax' }
  return { title: `${template.title} — Templates Kaxolax`, description: template.description }
}

/** Fiche publique d'un template : aperçu PDF et « Utiliser ce template ». */
export default async function TemplateDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const [{ id }, query, { isAuthenticated }] = await Promise.all([params, searchParams, auth()])
  const template = await loadTemplate(id)
  if (template === 'not-found') notFound()
  return (
    <GalleryShell isAuthenticated={isAuthenticated}>
      {template === 'unavailable' ? (
        <div className="flex flex-col items-start gap-3">
          <Alert variant="destructive">
            La galerie est momentanément indisponible. Réessayez dans quelques instants.
          </Alert>
          <Button asChild variant="outline">
            <Link href="/templates">Retour à la galerie</Link>
          </Button>
        </div>
      ) : (
        <TemplatePage template={template} autoUse={query[USE_TEMPLATE_PARAM] === '1'} />
      )}
    </GalleryShell>
  )
}
