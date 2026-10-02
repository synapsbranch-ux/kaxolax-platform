'use client'

import type { TemplateSummary } from '@kaxolax/contracts'
import { ArrowLeftIcon } from 'lucide-react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useCallback } from 'react'
import { templateHref } from '@/lib/templates'
import { TemplateDetail } from './template-detail'
import { UseTemplateButton } from './use-template'

/**
 * Contenu de la fiche publique d'un template. `autoUse` : retour de la connexion Clerk
 * (`?use=1`), la création reprend ; le paramètre est ensuite retiré de l'URL.
 */
export function TemplatePage({
  template,
  autoUse,
}: {
  template: TemplateSummary
  autoUse: boolean
}) {
  const router = useRouter()
  const resumed = useCallback(() => {
    router.replace(templateHref(template.id), { scroll: false })
  }, [router, template.id])
  return (
    <div className="flex flex-col gap-4">
      <Link
        href="/templates"
        className="flex items-center gap-1.5 self-start rounded-md text-sm text-muted-foreground outline-none hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50"
      >
        <ArrowLeftIcon className="size-4" /> Tous les templates
      </Link>
      <TemplateDetail
        template={template}
        action={<UseTemplateButton template={template} autoOpen={autoUse} onResumed={resumed} />}
      />
    </div>
  )
}
