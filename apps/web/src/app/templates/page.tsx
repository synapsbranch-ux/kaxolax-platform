import { auth } from '@clerk/nextjs/server'
import type { Metadata } from 'next'
import { GalleryShell } from '@/components/templates/gallery-shell'
import { TemplateGallery } from '@/components/templates/template-gallery'
import { fetchTemplates } from '@/lib/templates-server'

export const metadata: Metadata = {
  title: 'Templates LaTeX — Kaxolax',
  description:
    'Templates LaTeX prêts à compiler : CV, thèse, article, présentation Beamer, lettre et rapport.',
}

/** Galerie publique des templates (sans compte) ; la création d'un projet demande la connexion. */
export default async function TemplatesPage() {
  const [{ isAuthenticated }, templates] = await Promise.all([auth(), fetchTemplates()])
  return (
    <GalleryShell isAuthenticated={isAuthenticated}>
      <div className="mb-6 flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">Templates</h1>
        <p className="text-muted-foreground">
          Des documents LaTeX prêts à compiler, à ouvrir comme nouveau projet.
        </p>
      </div>
      <TemplateGallery initial={templates} />
    </GalleryShell>
  )
}
