'use client'

import type { TemplateSummary } from '@kaxolax/contracts'
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@kaxolax/ui'
import { ArrowLeftIcon, ExternalLinkIcon } from 'lucide-react'
import Link from 'next/link'
import { useState } from 'react'
import { templateHref } from '@/lib/templates'
import { TemplateDetail } from './template-detail'
import { TemplateGallery } from './template-gallery'
import { UseTemplateButton } from './use-template'

/**
 * « Nouveau projet depuis un template » du tableau de bord : la galerie dans une boîte de
 * dialogue, puis la fiche du template choisi (aperçu PDF) et la création dans le workspace
 * affiché.
 */
export function TemplatePickerDialog({
  open,
  onOpenChange,
  workspaceId,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  workspaceId: string | null
}) {
  const [selected, setSelected] = useState<TemplateSummary | null>(null)
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) setSelected(null)
        onOpenChange(next)
      }}
    >
      <DialogContent
        className="flex h-[min(92dvh,56rem)] max-w-[calc(100%-1rem)] flex-col gap-4 overflow-hidden p-4 sm:max-w-6xl sm:p-6"
        data-testid="template-picker"
      >
        <DialogHeader className="pr-8">
          <DialogTitle>Nouveau projet depuis un template</DialogTitle>
          <DialogDescription>
            {selected === null
              ? 'Choisissez un modèle de départ : CV, thèse, article, présentation, lettre ou rapport.'
              : 'Aperçu du template choisi.'}{' '}
            <Link
              href={selected === null ? '/templates' : templateHref(selected.id)}
              target="_blank"
              className="inline-flex items-center gap-1 rounded-sm text-foreground underline underline-offset-4 outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
            >
              {selected === null ? 'Ouvrir la galerie' : 'Page publique du template'}
              <ExternalLinkIcon className="size-3.5" aria-hidden />
            </Link>
          </DialogDescription>
        </DialogHeader>
        <div className="min-h-0 flex-1 overflow-y-auto">
          {selected === null ? (
            <TemplateGallery onOpen={setSelected} autoFocusSearch />
          ) : (
            <div className="flex flex-col gap-3">
              <Button
                variant="ghost"
                size="sm"
                className="self-start"
                onClick={() => {
                  setSelected(null)
                }}
              >
                <ArrowLeftIcon /> Retour à la galerie
              </Button>
              <TemplateDetail
                template={selected}
                headingLevel={2}
                action={<UseTemplateButton template={selected} workspaceId={workspaceId} />}
              />
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
