import {
  addZoteroCitationResponseSchema,
  type AddZoteroCitationResponse,
  type LinkZoteroInput,
  projectZoteroResponseSchema,
  type ProjectZoteroResponse,
  ZOTERO_ERRORS,
  zoteroCollectionsResponseSchema,
  type ZoteroCollection,
  zoteroConnectionResponseSchema,
  type ZoteroConnectionResponse,
  zoteroConnectResponseSchema,
  type ZoteroConnectResponse,
  type ZoteroLibrary,
  zoteroLibrariesResponseSchema,
  type ZoteroLibraryType,
  type ZoteroLink,
  zoteroSearchResponseSchema,
  type ZoteroSearchItem,
  zoteroSyncResponseSchema,
  type ZoteroSyncResponse,
  type ZoteroSyncTrigger,
  type ZoteroUpdatedEvent,
} from '@kaxolax/contracts'
import type { ExternalCitation } from '@kaxolax/editor'
import { apiRequest, localizedErrorMessage } from './api'

/**
 * Intégration Zotero côté web : appels de l'API (réponses validées par `@kaxolax/contracts`,
 * zotero.ts), messages en français et état affiché du lien d'un projet.
 */

export const zoteroApi = {
  /** État de la connexion du compte (et disponibilité de l'intégration). */
  connection: (): Promise<ZoteroConnectionResponse> =>
    apiRequest<unknown>('GET', '/me/integrations/zotero').then((data) =>
      zoteroConnectionResponseSchema.parse(data),
    ),
  /** Démarre l'OAuth : URL de zotero.org où envoyer le navigateur. */
  connect: (): Promise<ZoteroConnectResponse> =>
    apiRequest<unknown>('POST', '/me/integrations/zotero/connect').then((data) =>
      zoteroConnectResponseSchema.parse(data),
    ),
  /** Termine l'OAuth avec les paramètres reçus par la page de rappel. */
  complete: (query: { oauthToken: string; oauthVerifier: string; state: string }) =>
    apiRequest<unknown>(
      'GET',
      `/integrations/zotero/callback?${new URLSearchParams({
        oauth_token: query.oauthToken,
        oauth_verifier: query.oauthVerifier,
        state: query.state,
      }).toString()}`,
    ),
  disconnect: () => apiRequest<null>('DELETE', '/me/integrations/zotero'),
  libraries: (): Promise<ZoteroLibrary[]> =>
    apiRequest<unknown>('GET', '/me/integrations/zotero/libraries').then(
      (data) => zoteroLibrariesResponseSchema.parse(data).libraries,
    ),
  collections: (type: ZoteroLibraryType, libraryId: string): Promise<ZoteroCollection[]> =>
    apiRequest<unknown>(
      'GET',
      `/me/integrations/zotero/libraries/${type}/${encodeURIComponent(libraryId)}/collections`,
    ).then((data) => zoteroCollectionsResponseSchema.parse(data).collections),

  project: (projectId: string): Promise<ProjectZoteroResponse> =>
    apiRequest<unknown>('GET', `/projects/${projectId}/zotero`).then((data) =>
      projectZoteroResponseSchema.parse(data),
    ),
  link: (projectId: string, input: LinkZoteroInput): Promise<ProjectZoteroResponse> =>
    apiRequest<unknown>('PUT', `/projects/${projectId}/zotero`, input).then((data) =>
      projectZoteroResponseSchema.parse(data),
    ),
  unlink: (projectId: string) => apiRequest<null>('DELETE', `/projects/${projectId}/zotero`),
  sync: (projectId: string, trigger: ZoteroSyncTrigger): Promise<ZoteroSyncResponse> =>
    apiRequest<unknown>('POST', `/projects/${projectId}/zotero/sync`, { trigger }).then((data) =>
      zoteroSyncResponseSchema.parse(data),
    ),
  search: (projectId: string, q: string, signal?: AbortSignal): Promise<ZoteroSearchItem[]> => {
    const request = apiRequest<unknown>(
      'GET',
      `/projects/${projectId}/zotero/search?${new URLSearchParams({ q }).toString()}`,
    ).then((data) => zoteroSearchResponseSchema.parse(data).items)
    // La requête n'est pas annulée côté réseau ; son résultat est ignoré une fois abandonné.
    if (!signal) return request
    return new Promise((resolve, reject) => {
      const abort = () => {
        reject(new DOMException('Aborted', 'AbortError'))
      }
      if (signal.aborted) abort()
      signal.addEventListener('abort', abort, { once: true })
      request.then(resolve, reject)
    })
  },
  addCitation: (projectId: string, itemKey: string): Promise<AddZoteroCitationResponse> =>
    apiRequest<unknown>('POST', `/projects/${projectId}/zotero/citations`, { itemKey }).then(
      (data) => addZoteroCitationResponseSchema.parse(data),
    ),
}

const MESSAGES: Readonly<Record<string, string>> = {
  [ZOTERO_ERRORS.unavailable]: 'L’intégration Zotero n’est pas configurée sur ce service.',
  [ZOTERO_ERRORS.notConnected]: 'Connectez d’abord votre compte Zotero (Compte → Intégrations).',
  [ZOTERO_ERRORS.invalidOAuthState]:
    'Autorisation Zotero inconnue ou expirée : recommencez la connexion depuis cet onglet.',
  [ZOTERO_ERRORS.oauthFailed]: 'Zotero a refusé l’autorisation. Réessayez.',
  [ZOTERO_ERRORS.keyInvalid]:
    'La clé Zotero a été révoquée : le membre qui a lié le projet doit reconnecter Zotero, ou un éditeur refaire le lien.',
  [ZOTERO_ERRORS.notLinked]: 'Ce projet n’est lié à aucune bibliothèque Zotero.',
  [ZOTERO_ERRORS.libraryNotFound]: 'Bibliothèque ou collection Zotero introuvable.',
  [ZOTERO_ERRORS.libraryForbidden]:
    'La clé Zotero n’a pas accès à cette bibliothèque : le membre qui a lié le projet doit lui redonner cet accès (zotero.org → Settings → Security) ou reconnecter Zotero, ou un éditeur lier une autre bibliothèque.',
  [ZOTERO_ERRORS.backoff]: 'Zotero demande de patienter avant la prochaine requête.',
  [ZOTERO_ERRORS.requestFailed]: 'Zotero ne répond pas. Réessayez dans un instant.',
  [ZOTERO_ERRORS.syncInProgress]: 'Une synchronisation est déjà en cours.',
  [ZOTERO_ERRORS.bibTooLarge]:
    'La bibliographie exportée dépasse 2 Mo : choisissez une collection.',
  [ZOTERO_ERRORS.invalidTarget]: 'Le fichier cible doit être un fichier .bib du projet.',
  [ZOTERO_ERRORS.targetExists]:
    'Un fichier de ce nom existe déjà : choisissez-le dans la liste pour le remplacer, ou donnez un autre nom.',
  [ZOTERO_ERRORS.itemNotFound]: 'Référence introuvable dans la bibliothèque ou la collection liée.',
  [ZOTERO_ERRORS.pickedLimit]:
    'Trop de références ajoutées hors de la collection liée (500) : ajoutez-les à la collection dans Zotero, ou liez toute la bibliothèque.',
  [ZOTERO_ERRORS.realtimeUnavailable]:
    'La mise à jour de la bibliographie n’a pas pu être confirmée (connexion au serveur) : réessayez.',
  [ZOTERO_ERRORS.oauthTooMany]:
    'Trop de demandes de connexion à Zotero : patientez quelques secondes, ou terminez celle ouverte dans un autre onglet.',
  E_PLAN_LIMIT: 'Le stockage du plan du propriétaire du projet est plein.',
}

/** Message français d'une erreur de l'intégration. */
export function zoteroErrorMessage(error: unknown): string {
  return localizedErrorMessage(error, MESSAGES)
}

/** Message français d'un code d'erreur enregistré sur le lien (`lastError`). */
export function zoteroErrorCodeMessage(code: string): string {
  return MESSAGES[code] ?? 'La dernière synchronisation a échoué.'
}

/** Date relative courte (« il y a 5 min »). */
export function relativeTime(iso: string, now: number): string {
  const seconds = Math.max(0, Math.round((now - Date.parse(iso)) / 1000))
  if (seconds < 60) return 'à l’instant'
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `il y a ${String(minutes)} min`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `il y a ${String(hours)} h`
  return `il y a ${String(Math.round(hours / 24))} j`
}

/** État affiché du lien : ce qui se passe, et l'erreur éventuelle. */
export interface ZoteroLinkStatus {
  tone: 'ok' | 'busy' | 'error' | 'waiting'
  label: string
  error: string | null
}

export function zoteroLinkStatus(link: ZoteroLink, now: number): ZoteroLinkStatus {
  const backoff = link.backoffUntil === null ? 0 : Date.parse(link.backoffUntil) - now
  const synced =
    link.lastSyncedAt === null
      ? 'Jamais synchronisé'
      : `Synchronisé ${relativeTime(link.lastSyncedAt, now)}`
  if (link.syncStatus === 'syncing') {
    return { tone: 'busy', label: 'Synchronisation en cours…', error: null }
  }
  if (!link.hasKey) {
    return { tone: 'error', label: synced, error: zoteroErrorCodeMessage(ZOTERO_ERRORS.keyInvalid) }
  }
  if (link.syncStatus === 'error') {
    return {
      tone: backoff > 0 ? 'waiting' : 'error',
      label: synced,
      error:
        link.lastError === null
          ? 'La dernière synchronisation a échoué.'
          : zoteroErrorCodeMessage(link.lastError),
    }
  }
  if (backoff > 0) {
    return {
      tone: 'waiting',
      label: `${synced} · Zotero demande d’attendre ${String(Math.ceil(backoff / 1000))} s`,
      error: null,
    }
  }
  return { tone: 'ok', label: synced, error: null }
}

/** Nom affiché de la source synchronisée (« Thesis (Ma bibliothèque) »). */
export function zoteroSourceLabel(link: ZoteroLink): string {
  const library = link.libraryName ?? (link.libraryType === 'user' ? 'Bibliothèque' : 'Groupe')
  return link.collectionKey === null
    ? `${library} (toute la bibliothèque)`
    : `${link.collectionName ?? link.collectionKey} — ${library}`
}

/** Résultats de recherche proposés à l'autocomplétion (avec une clé de citation). */
export function citationsOf(items: readonly ZoteroSearchItem[]): ExternalCitation[] {
  return items.flatMap((item) =>
    item.citationKey === null
      ? []
      : [
          {
            key: item.citationKey,
            id: item.itemKey,
            title: item.title,
            detail: [item.creators, item.year ?? ''].filter((part) => part !== '').join(' '),
          },
        ],
  )
}

/** Collections triées en arbre (parents avant enfants), avec leur profondeur. */
export function collectionTree(
  collections: readonly ZoteroCollection[],
): { collection: ZoteroCollection; depth: number }[] {
  const children = new Map<string | null, ZoteroCollection[]>()
  const keys = new Set(collections.map((collection) => collection.key))
  for (const collection of collections) {
    const parent =
      collection.parentKey !== null && keys.has(collection.parentKey) ? collection.parentKey : null
    const list = children.get(parent) ?? []
    list.push(collection)
    children.set(parent, list)
  }
  const result: { collection: ZoteroCollection; depth: number }[] = []
  const visit = (parent: string | null, depth: number, seen: Set<string>) => {
    const list = [...(children.get(parent) ?? [])].sort((a, b) => a.name.localeCompare(b.name))
    for (const collection of list) {
      if (seen.has(collection.key)) continue
      seen.add(collection.key)
      result.push({ collection, depth })
      visit(collection.key, depth + 1, seen)
    }
  }
  visit(null, 0, new Set())
  return result
}

type ZoteroListener = (event: ZoteroUpdatedEvent) => void
const zoteroListeners = new Set<ZoteroListener>()

/**
 * Lien Zotero modifié ou synchronisé (événement `zotero.updated` du document meta) : la page
 * projet le publie, le panneau Zotero et la source de citations s'y abonnent.
 */
export const zoteroFeed = {
  publish(event: ZoteroUpdatedEvent): void {
    for (const listener of [...zoteroListeners]) listener(event)
  },
  subscribe(listener: ZoteroListener): () => void {
    zoteroListeners.add(listener)
    return () => {
      zoteroListeners.delete(listener)
    }
  },
}

/** Boîtes de dialogue des actions Zotero (`host.openDialog(id)`). */
export const ZOTERO_DIALOGS = {
  /** Panneau du lien : bibliothèque, collection, `.bib`, synchronisation (menu Fichier). */
  panel: 'file.zotero',
  /** Sélecteur de citations (menu Structures). */
  cite: 'structures.zotero-cite',
} as const
