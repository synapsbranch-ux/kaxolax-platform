import { z } from 'zod'

/**
 * Intégrations externes d'un projet : dépôt Git (GitHub, tâche 8) et bibliothèque Zotero
 * (tâche 9). Schéma posé par la tâche 1 : un lien par projet et par intégration, créé par un
 * membre (propriétaire du lien) dont les jetons OAuth sont chiffrés au repos (`APP_KEY`) et ne
 * sortent jamais de l'API. Dates ISO 8601 en UTC.
 */

const isoDate = z.iso.datetime()

/** État de la dernière synchronisation. */
export const integrationSyncStatusSchema = z.enum(['idle', 'syncing', 'error'])
export type IntegrationSyncStatus = z.infer<typeof integrationSyncStatusSchema>

export const gitProviderSchema = z.enum(['github'])
export type GitProvider = z.infer<typeof gitProviderSchema>

/** Lien projet ↔ dépôt, tel que renvoyé par l'API (sans jeton). */
export const gitLinkSchema = z.object({
  id: z.uuid(),
  projectId: z.uuid(),
  /** Membre qui a créé le lien (ses jetons servent à la synchronisation). */
  ownerId: z.uuid(),
  provider: gitProviderSchema,
  repositoryOwner: z.string(),
  repositoryName: z.string(),
  branch: z.string(),
  syncStatus: integrationSyncStatusSchema,
  lastSyncedAt: isoDate.nullable(),
  /** SHA du dernier commit synchronisé. */
  lastSyncedCommit: z.string().nullable(),
  lastError: z.string().nullable(),
  createdAt: isoDate,
})
export type GitLink = z.infer<typeof gitLinkSchema>

export const zoteroLibraryTypeSchema = z.enum(['user', 'group'])
export type ZoteroLibraryType = z.infer<typeof zoteroLibraryTypeSchema>

/** Format d'export de la synchronisation (paramètre `format` de l'API Web v3 de Zotero). */
export const zoteroExportFormatSchema = z.enum(['biblatex', 'bibtex'])
export type ZoteroExportFormat = z.infer<typeof zoteroExportFormatSchema>

/** Lien projet ↔ bibliothèque (ou collection) Zotero, tel que renvoyé par l'API (sans jeton). */
export const zoteroLinkSchema = z.object({
  id: z.uuid(),
  projectId: z.uuid(),
  ownerId: z.uuid(),
  /** Nom du membre qui a lié (sa clé Zotero sert à la synchronisation), null s'il est inconnu. */
  ownerName: z.string().nullable(),
  libraryType: zoteroLibraryTypeSchema,
  libraryId: z.string(),
  /** Nom de la bibliothèque au moment du lien (affichage). */
  libraryName: z.string().nullable(),
  /** Collection synchronisée ; null : toute la bibliothèque. */
  collectionKey: z.string().nullable(),
  collectionName: z.string().nullable(),
  /** Document `.bib` du projet alimenté par la synchronisation. */
  documentId: z.uuid().nullable(),
  /** Chemin de ce document dans le projet, null s'il a été supprimé. */
  documentPath: z.string().nullable(),
  exportFormat: zoteroExportFormatSchema,
  syncStatus: integrationSyncStatusSchema,
  lastSyncedAt: isoDate.nullable(),
  /** Version de la bibliothèque à la dernière synchronisation (en-tête `Last-Modified-Version`). */
  lastLibraryVersion: z.number().int().nonnegative().nullable(),
  lastError: z.string().nullable(),
  /** Zotero a demandé une pause (`Backoff`, `Retry-After`) : pas de requête avant cette date. */
  backoffUntil: isoDate.nullable(),
  /** Faux si la clé du propriétaire du lien a été révoquée : il faut le refaire. */
  hasKey: z.boolean(),
  createdAt: isoDate,
})
export type ZoteroLink = z.infer<typeof zoteroLinkSchema>
