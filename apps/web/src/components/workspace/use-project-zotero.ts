'use client'

import type { ZoteroLink } from '@kaxolax/contracts'
import type { ActionHost, CitationProvider } from '@kaxolax/editor'
import { useCallback, useEffect, useRef, useState } from 'react'
import { citationsOf, zoteroApi, zoteroErrorMessage, zoteroFeed } from '@/lib/zotero'

export interface ProjectZotero {
  /** Lien du projet (null : pas de lien, ou pas encore lu). */
  link: ZoteroLink | null
  /** Source de citations de l'autocomplétion (null sans lien utilisable ou en lecture seule). */
  citationProvider: () => CitationProvider | null
}

/**
 * Lien Zotero du projet ouvert. À l'ouverture, un membre qui peut éditer déclenche la
 * synchronisation `open` (l'API la limite à une tentative par période et n'écrit rien si la
 * bibliothèque n'a pas changé) ; les erreurs restent sur le lien, affichées par le panneau
 * Zotero. Le lien suit ensuite les événements `zotero.updated`. Tant qu'un lien utilisable
 * existe, l'autocomplétion de `\cite{` cherche aussi dans la bibliothèque liée, et choisir une
 * référence ajoute son entrée au `.bib`.
 */
export function useProjectZotero(
  projectId: string,
  /** Rôle du membre : peut-il éditer ? null tant que le projet n'est pas chargé. */
  canEdit: boolean | null,
  notify: NonNullable<ActionHost['notify']>,
): ProjectZotero {
  const [link, setLink] = useState<ZoteroLink | null>(null)

  useEffect(() => {
    if (canEdit === null) return
    const state = { live: true }
    const load = canEdit
      ? zoteroApi.sync(projectId, 'open').then((result) => result.link)
      : zoteroApi.project(projectId).then((result) => result.link)
    load.then(
      (current) => {
        if (state.live) setLink(current)
      },
      () => {
        // Synchro refusée (pause, clé révoquée…) : le lien reste lisible avec son erreur.
        zoteroApi.project(projectId).then(
          (result) => {
            if (state.live) setLink(result.link)
          },
          () => undefined,
        )
      },
    )
    // Événements du document meta de ce projet : le lien annoncé remplace le précédent.
    const unsubscribe = zoteroFeed.subscribe((event) => {
      setLink(event.link)
    })
    return () => {
      state.live = false
      unsubscribe()
    }
  }, [projectId, canEdit])

  const provider = useRef<CitationProvider | null>(null)
  const usable = canEdit === true && link !== null && link.hasKey && link.documentId !== null
  useEffect(() => {
    provider.current = usable
      ? {
          name: 'Zotero',
          search: (query, signal) =>
            zoteroApi.search(projectId, query, signal).then((items) => citationsOf(items)),
          // Clé retenue par l'API (unique dans le .bib) : l'éditeur corrige la clé insérée. Échec
          // (null) : l'éditeur retire la clé insérée, qui ne correspondrait à aucune entrée.
          pick: (citation) =>
            zoteroApi.addCitation(projectId, citation.id).then(
              (result) => {
                if (result.added) notify(`Référence ${result.citationKey} ajoutée au .bib.`)
                return result.citationKey
              },
              (error: unknown) => {
                notify(zoteroErrorMessage(error), 'error')
                return null
              },
            ),
        }
      : null
  }, [usable, projectId, notify])

  const citationProvider = useCallback(() => provider.current, [])
  return { link, citationProvider }
}
