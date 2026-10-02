'use client'

import { Button, Spinner } from '@kaxolax/ui'
import { useEffect, useState } from 'react'
import { api, errorMessage, type TreeFile } from '@/lib/api'

const PREVIEWABLE = ['image/png', 'image/jpeg', 'image/gif', 'image/svg+xml', 'image/webp']

/** Aperçu d'un fichier binaire : les images s'affichent, les autres se téléchargent. Monté avec `key={file.id}`. */
export function FilePreview({ projectId, file }: { projectId: string; file: TreeFile }) {
  const [url, setUrl] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const previewable = PREVIEWABLE.includes(file.mimeType)

  useEffect(() => {
    let active = true
    api.fileUrl(projectId, file.id).then(
      ({ url: signed }) => {
        if (active) setUrl(signed)
      },
      (caught: unknown) => {
        if (active) setError(errorMessage(caught))
      },
    )
    return () => {
      active = false
    }
  }, [projectId, file.id])

  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 overflow-auto bg-editor p-6 text-editor-foreground">
      <p className="font-mono text-sm">{file.path}</p>
      {previewable && url ? (
        // Aperçu d'un fichier du projet servi par une URL présignée (S3) : pas d'optimisation next/image.
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={url}
          alt={file.name}
          className="max-h-[70vh] max-w-full rounded border border-editor-border bg-pdf-page"
          data-testid="image-preview"
        />
      ) : null}
      {error !== null ? (
        <p className="text-sm text-destructive" role="alert">
          Aperçu indisponible : {error}
        </p>
      ) : null}
      {previewable && url === null && error === null ? (
        <p className="flex items-center gap-2 text-sm text-editor-gutter-foreground">
          <Spinner label="" /> Chargement de l'aperçu…
        </p>
      ) : null}
      {!previewable ? (
        <p className="text-sm text-editor-gutter-foreground">
          Pas d'aperçu pour ce type de fichier ({file.mimeType}).
        </p>
      ) : null}
      <Button
        variant="outline"
        size="sm"
        onClick={() => {
          api.fileUrl(projectId, file.id, true).then(
            ({ url: signed }) => {
              window.location.assign(signed)
            },
            (caught: unknown) => {
              setError(errorMessage(caught))
            },
          )
        }}
      >
        Télécharger ({Math.ceil(file.sizeBytes / 1024)} Ko)
      </Button>
    </div>
  )
}
