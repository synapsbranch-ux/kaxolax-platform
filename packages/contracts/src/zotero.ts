import { z } from 'zod'
import { entityNameSchema } from './names.js'
import {
  zoteroExportFormatSchema,
  zoteroLibraryTypeSchema,
  zoteroLinkSchema,
} from './integrations.js'

/**
 * Intégration Zotero (tâche 9) : connexion du compte par OAuth 1.0a, lien d'un projet à une
 * bibliothèque (personnelle ou de groupe) ou à une collection, synchronisation vers un `.bib` du
 * projet et sélecteur de citations. La clé d'API Zotero ne sort jamais de l'API.
 *
 * Routes (préfixe `/api/v1`) :
 * - `GET /me/integrations/zotero` : état de la connexion du compte ;
 * - `POST /me/integrations/zotero/connect` : démarre l'OAuth, renvoie l'URL d'autorisation ;
 * - `GET /integrations/zotero/callback?oauth_token=&oauth_verifier=&state=` : termine l'OAuth
 *   (appelée par la page `/integrations/zotero/callback` du web, même session Clerk) ;
 * - `DELETE /me/integrations/zotero` : révoque la clé (chez Zotero si possible) et l'efface ;
 * - `GET /me/integrations/zotero/libraries` et `…/libraries/:type/:id/collections` ;
 * - `GET|PUT|DELETE /projects/:id/zotero` : lien du projet ;
 * - `POST /projects/:id/zotero/sync` : synchronisation (à la demande ou à l'ouverture) ;
 * - `GET /projects/:id/zotero/search?q=` et `POST /projects/:id/zotero/citations`.
 */

/** Codes d'erreur propres à Zotero. */
export const ZOTERO_ERRORS = {
  /** `ZOTERO_CLIENT_KEY`/`ZOTERO_CLIENT_SECRET` absentes (503). */
  unavailable: 'E_ZOTERO_UNAVAILABLE',
  /** Le compte n'a pas connecté Zotero (409). */
  notConnected: 'E_ZOTERO_NOT_CONNECTED',
  /** Demande OAuth inconnue, expirée, d'un autre compte ou d'une autre session (400). */
  invalidOAuthState: 'E_ZOTERO_OAUTH_STATE',
  /** Zotero a refusé l'échange OAuth (502). */
  oauthFailed: 'E_ZOTERO_OAUTH_FAILED',
  /** Clé refusée par Zotero (403 côté Zotero) : à reconnecter (409). */
  keyInvalid: 'E_ZOTERO_KEY_INVALID',
  /** Le projet n'est lié à aucune bibliothèque (404). */
  notLinked: 'E_ZOTERO_NOT_LINKED',
  /** Bibliothèque ou collection inaccessible avec la clé (404 côté Zotero). */
  libraryNotFound: 'E_ZOTERO_LIBRARY_NOT_FOUND',
  /**
   * La clé est valide mais n'a pas accès à cette bibliothèque (droits réduits sur la page
   * d'autorisation de zotero.org, ou modifiés depuis) : 403.
   */
  libraryForbidden: 'E_ZOTERO_LIBRARY_FORBIDDEN',
  /** Zotero demande d'attendre (`Backoff`, `Retry-After`, 429) : `retryAfterSeconds` (429). */
  backoff: 'E_ZOTERO_BACKOFF',
  /** Zotero n'a pas répondu ou a répondu une erreur (502). */
  requestFailed: 'E_ZOTERO_REQUEST_FAILED',
  /** Synchronisation déjà en cours (409). */
  syncInProgress: 'E_ZOTERO_SYNC_IN_PROGRESS',
  /** Le `.bib` exporté dépasserait la taille d'un document texte (422). */
  bibTooLarge: 'E_ZOTERO_BIB_TOO_LARGE',
  /** Document cible absent du projet, ou qui n'est pas un `.bib` (422). */
  invalidTarget: 'E_ZOTERO_INVALID_TARGET',
  /** « Nouveau fichier » : un document de ce nom existe déjà dans ce dossier (409). */
  targetExists: 'E_ZOTERO_TARGET_EXISTS',
  /**
   * Élément Zotero introuvable dans la bibliothèque liée, ou (pour un autre éditeur que celui qui
   * a lié) hors de la collection liée (404).
   */
  itemNotFound: 'E_ZOTERO_ITEM_NOT_FOUND',
  /** Déjà `ZOTERO_MAX_PICKED_ITEMS` éléments ajoutés hors de la collection liée (422). */
  pickedLimit: 'E_ZOTERO_PICKED_LIMIT',
  /**
   * Le service temps réel n'a pas confirmé l'écriture du `.bib` (pas de réponse, délai dépassé) :
   * elle a pu se faire ou non, il faut réessayer (503).
   */
  realtimeUnavailable: 'E_ZOTERO_REALTIME_UNAVAILABLE',
  /** Trop de demandes de connexion OAuth en cours ou trop rapprochées pour ce compte (429). */
  oauthTooMany: 'E_ZOTERO_OAUTH_TOO_MANY',
} as const

/** Délai minimal entre deux synchronisations déclenchées par l'ouverture du projet. */
export const ZOTERO_AUTO_SYNC_MINUTES = 15
/** Recherche : longueur de la requête, nombre de résultats. */
export const ZOTERO_SEARCH_MIN_LENGTH = 2
export const ZOTERO_SEARCH_MAX_LENGTH = 200
export const ZOTERO_SEARCH_LIMIT = 25
/** Éléments ajoutés hors collection par le sélecteur de citations, gardés par la synchro. */
export const ZOTERO_MAX_PICKED_ITEMS = 500
/** Éléments exportés au plus par synchronisation. */
export const ZOTERO_MAX_EXPORTED_ITEMS = 5000
/** Sous-collections exportées au plus avec la collection liée (une requête chacune). */
export const ZOTERO_MAX_SUBCOLLECTIONS = 200

/** Clé Zotero d'un élément ou d'une collection (8 caractères, alphabet sans ambiguïté). */
export const zoteroKeySchema = z.string().regex(/^[23456789ABCDEFGHIJKLMNPQRSTUVWXYZ]{8}$/)
/** Identifiant numérique d'une bibliothèque (utilisateur ou groupe). */
export const zoteroLibraryIdSchema = z.string().regex(/^[1-9][0-9]{0,15}$/)

/** Compte Zotero connecté (sans la clé). */
export const zoteroConnectionSchema = z.object({
  zoteroUserId: z.string(),
  username: z.string().nullable(),
  connectedAt: z.iso.datetime(),
})
export type ZoteroConnection = z.infer<typeof zoteroConnectionSchema>

/** `GET /me/integrations/zotero`. */
export const zoteroConnectionResponseSchema = z.object({
  /** Faux si l'intégration n'est pas configurée sur ce déploiement. */
  available: z.boolean(),
  connection: zoteroConnectionSchema.nullable(),
})
export type ZoteroConnectionResponse = z.infer<typeof zoteroConnectionResponseSchema>

/** `POST /me/integrations/zotero/connect` : URL zotero.org où envoyer le navigateur. */
export const zoteroConnectResponseSchema = z.object({
  authorizeUrl: z.url(),
  expiresAt: z.iso.datetime(),
})
export type ZoteroConnectResponse = z.infer<typeof zoteroConnectResponseSchema>

/** Paramètres de `GET /integrations/zotero/callback`. */
export const zoteroCallbackQuerySchema = z.object({
  oauth_token: z.string().min(1).max(200),
  oauth_verifier: z.string().min(1).max(200),
  state: z.string().min(1).max(200),
})
export type ZoteroCallbackQuery = z.infer<typeof zoteroCallbackQuerySchema>

export const zoteroLibrarySchema = z.object({
  type: zoteroLibraryTypeSchema,
  id: zoteroLibraryIdSchema,
  name: z.string(),
})
export type ZoteroLibrary = z.infer<typeof zoteroLibrarySchema>

export const zoteroLibrariesResponseSchema = z.object({ libraries: z.array(zoteroLibrarySchema) })
export type ZoteroLibrariesResponse = z.infer<typeof zoteroLibrariesResponseSchema>

export const zoteroCollectionSchema = z.object({
  key: zoteroKeySchema,
  name: z.string(),
  parentKey: zoteroKeySchema.nullable(),
})
export type ZoteroCollection = z.infer<typeof zoteroCollectionSchema>

export const zoteroCollectionsResponseSchema = z.object({
  collections: z.array(zoteroCollectionSchema),
})
export type ZoteroCollectionsResponse = z.infer<typeof zoteroCollectionsResponseSchema>

/** Document `.bib` cible : un document existant du projet, ou un nouveau. */
export const zoteroBibTargetSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('existing'), documentId: z.uuid() }),
  z.object({
    kind: z.literal('new'),
    name: entityNameSchema.refine((name) => name.toLowerCase().endsWith('.bib'), {
      message: 'The bibliography file must end with .bib',
    }),
    folderId: z.uuid().nullable(),
  }),
])
export type ZoteroBibTarget = z.infer<typeof zoteroBibTargetSchema>

/** `PUT /projects/:id/zotero` : lie (ou relie) le projet avec la clé du compte connecté. */
export const linkZoteroInputSchema = z.object({
  libraryType: zoteroLibraryTypeSchema,
  libraryId: zoteroLibraryIdSchema,
  collectionKey: zoteroKeySchema.nullable(),
  target: zoteroBibTargetSchema,
  exportFormat: zoteroExportFormatSchema.default('biblatex'),
})
export type LinkZoteroInput = z.input<typeof linkZoteroInputSchema>

/** `GET /projects/:id/zotero`. */
export const projectZoteroResponseSchema = z.object({
  available: z.boolean(),
  link: zoteroLinkSchema.nullable(),
})
export type ProjectZoteroResponse = z.infer<typeof projectZoteroResponseSchema>

export const zoteroSyncTriggerSchema = z.enum(['manual', 'open'])
export type ZoteroSyncTrigger = z.infer<typeof zoteroSyncTriggerSchema>

export const zoteroSyncInputSchema = z.object({
  trigger: zoteroSyncTriggerSchema.default('manual'),
})

/**
 * Résultat d'une synchronisation : `updated` (le `.bib` a changé), `unchanged` (bibliothèque non
 * modifiée depuis la dernière synchro, ou même texte), `skipped` (projet non lié, synchro récente
 * à l'ouverture, pause demandée par Zotero, clé révoquée).
 */
export const zoteroSyncOutcomeSchema = z.enum(['updated', 'unchanged', 'skipped'])
export type ZoteroSyncOutcome = z.infer<typeof zoteroSyncOutcomeSchema>

export const zoteroSyncResponseSchema = z.object({
  outcome: zoteroSyncOutcomeSchema,
  link: zoteroLinkSchema.nullable(),
})
export type ZoteroSyncResponse = z.infer<typeof zoteroSyncResponseSchema>

export const zoteroSearchQuerySchema = z.object({
  q: z.string().trim().min(ZOTERO_SEARCH_MIN_LENGTH).max(ZOTERO_SEARCH_MAX_LENGTH),
})

/** Un résultat de recherche dans la bibliothèque liée. */
export const zoteroSearchItemSchema = z.object({
  itemKey: zoteroKeySchema,
  /**
   * Clé de citation (`\cite{…}`) : celle du `.bib` lié si l'élément y est, sinon celle qu'un ajout
   * lui donnerait (celle de Zotero, suivie d'un suffixe si un autre élément l'a déjà) ; null si
   * Zotero n'en a pas produit.
   */
  citationKey: z.string().nullable(),
  itemType: z.string(),
  title: z.string(),
  /** Auteurs abrégés (« Lovelace », « Lovelace et Babbage », « Lovelace et al. »). */
  creators: z.string(),
  year: z.string().nullable(),
  /** L'élément est déjà dans le `.bib` lié. */
  inBibliography: z.boolean(),
})
export type ZoteroSearchItem = z.infer<typeof zoteroSearchItemSchema>

export const zoteroSearchResponseSchema = z.object({ items: z.array(zoteroSearchItemSchema) })
export type ZoteroSearchResponse = z.infer<typeof zoteroSearchResponseSchema>

/** `POST /projects/:id/zotero/citations` : ajoute l'entrée de l'élément au `.bib` s'il manque. */
export const addZoteroCitationInputSchema = z.object({ itemKey: zoteroKeySchema })

export const addZoteroCitationResponseSchema = z.object({
  /** Clé de citation de l'élément dans le `.bib` (unique dans le fichier). */
  citationKey: z.string(),
  /** Faux si l'élément était déjà dans le `.bib`. */
  added: z.boolean(),
})
export type AddZoteroCitationResponse = z.infer<typeof addZoteroCitationResponseSchema>
