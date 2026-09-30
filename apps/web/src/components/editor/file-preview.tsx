'use client'

import { Button } from '@kaxolax/ui'
import { useEffect, useState } from 'react'
import { api, type TreeFile } from '@/lib/api'

const PREVIEWABLE = ['image/png', 'image/jpeg', 'image/gif', 'image/svg+xml', 'image/webp']

/** Aperçu d'un fichier binaire : les images s'affichent, les autres se téléchargent. Monté avec `key={file.id}`. */
export function FilePreview({ projectId, file }: { projectId: string; file: TreeFile }) {
  const [url, setUrl] = useState<string | null>(null)
  const previewable = PREVIEWABLE.includes(file.mimeType)

  useEffect(() => {
    let active = true
    void api.fileUrl(projectId, file.id).then(({ url: signed }) => {
      if (active) setUrl(signed)
    })
    return () => {
      active = false
    }
  }, [projectId, file.id])

  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 overflow-auto bg-muted p-6">
      <p className="text-sm font-medium">{file.path}</p>
      {previewable && url ? (
        // Aperçu d'un fichier du projet servi par une URL présignée (S3) : pas d'optimisation next/image.
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={url}
          alt={file.name}
          className="max-h-[70vh] max-w-full rounded border bg-white"
          data-testid="image-preview"
        />
      ) : null}
      {!previewable ? (
        <p className="text-sm text-muted-foreground">
          Pas d'aperçu pour ce type de fichier ({file.mimeType}).
        </p>
      ) : null}
      <Button
        variant="outline"
        size="sm"
        onClick={() =>
          void api
            .fileUrl(projectId, file.id, true)
            .then(({ url: signed }) => window.open(signed, '_blank'))
        }
      >
        Télécharger ({Math.ceil(file.sizeBytes / 1024)} Ko)
      </Button>
    </div>
  )
}
