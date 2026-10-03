import { z } from 'zod'
import { sha256Schema } from './common.js'

/**
 * Historique du projet (tâche 8) : contrats des routes `/api/v1/projects/:id/versions/*`, format
 * du manifeste d'une version (stockage objet) et routes internes du service temps réel utilisées
 * par l'historique. Dates ISO 8601 en UTC.
 *
 * Une version est créée après `HISTORY_IDLE_SECONDS` sans modification du projet (`auto`), à
 * chaque compilation manuelle (`compile`), avant chaque restauration (`restore` : l'état remplacé)
 * et juste après (`restored` : l'état restauré). Ses auteurs sont les comptes qui ont envoyé des
 * mises à jour Yjs depuis la version précédente ; pour `restored`, la personne qui restaure en
 * fait toujours partie (même quand seule l'arborescence a changé).
 */

const isoDate = z.iso.datetime()

/** Délai sans modification du projet avant la création d'une version automatique. */
export const HISTORY_IDLE_SECONDS = 120
/** Versions renvoyées par défaut, et au plus, par page de la liste. */
export const HISTORY_PAGE_SIZE = 50
export const HISTORY_PAGE_MAX_SIZE = 100
export const VERSION_LABEL_MAX_LENGTH = 100

export const versionKindSchema = z.enum(['auto', 'compile', 'restore', 'restored'])
export type VersionKind = z.infer<typeof versionKindSchema>

/** Codes d'erreur propres à l'historique (`code` du corps de la réponse). */
export const HISTORY_ERRORS = {
  /** 404 : version inconnue dans ce projet (ou purgée). */
  versionNotFound: 'E_VERSION_NOT_FOUND',
  /** 404 : fichier absent de cette version. */
  entryNotFound: 'E_VERSION_ENTRY_NOT_FOUND',
  /**
   * 409 : restauration d'un fichier supprimé dont le chemin est pris par un dossier (un document
   * ou un fichier qui l'occupe est remplacé, il reste dans la version de sauvegarde).
   */
  pathTaken: 'E_RESTORE_PATH_TAKEN',
  /**
   * 503 : le service temps réel n'a pas pu appliquer le texte restauré ; les textes déjà remplacés
   * ont été remis dans leur état d'avant (rien n'est modifié).
   */
  realtimeUnavailable: 'E_HISTORY_REALTIME_UNAVAILABLE',
  /**
   * 503 : restauration interrompue et textes déjà remplacés impossibles à remettre dans leur état
   * d'avant : le projet est partiellement restauré. Relancer la restauration (même version), ou
   * restaurer la version de sauvegarde (`backupVersionId`) pour revenir en arrière.
   */
  restoreIncomplete: 'E_HISTORY_RESTORE_INCOMPLETE',
} as const

/** Auteur d'une version (compte anonymisé depuis : nom nul). */
export const versionAuthorSchema = z.object({
  id: z.uuid(),
  name: z.string().nullable(),
  avatarUrl: z.string().nullable(),
})
export type VersionAuthor = z.infer<typeof versionAuthorSchema>

export const projectVersionSchema = z.object({
  id: z.uuid(),
  kind: versionKindSchema,
  label: z.string().nullable(),
  authorIds: z.array(z.uuid()),
  changedDocumentIds: z.array(z.uuid()),
  createdAt: isoDate,
})
export type ProjectVersion = z.infer<typeof projectVersionSchema>

/** `GET /projects/:id/versions?before=<versionId>&limit=` : du plus récent au plus ancien. */
export const versionListQuerySchema = z.object({
  before: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(HISTORY_PAGE_MAX_SIZE).default(HISTORY_PAGE_SIZE),
})
export type VersionListQuery = z.infer<typeof versionListQuerySchema>

export const versionListResponseSchema = z.object({
  versions: z.array(projectVersionSchema),
  /** Auteurs cités par les versions de la page. */
  authors: z.array(versionAuthorSchema),
  /** Curseur de la page suivante (`before`), null à la fin. */
  nextCursor: z.uuid().nullable(),
  /** Durée de conservation du plan du propriétaire, en jours ; null : historique complet. */
  retentionDays: z.number().int().positive().nullable(),
})
export type VersionListResponse = z.infer<typeof versionListResponseSchema>

/**
 * État d'un fichier dans une version, par rapport à la version précédente. `previousPath` est
 * renseigné quand le fichier a été renommé ou déplacé (il peut aussi être modifié).
 */
export const versionEntryStatusSchema = z.enum(['added', 'modified', 'deleted', 'unchanged'])
export type VersionEntryStatus = z.infer<typeof versionEntryStatusSchema>

export const versionEntrySchema = z.object({
  type: z.enum(['document', 'file']),
  id: z.uuid(),
  /** Chemin dans la version (pour un fichier supprimé : son chemin dans la version précédente). */
  path: z.string().min(1),
  status: versionEntryStatusSchema,
  previousPath: z.string().min(1).nullable(),
  sha256: sha256Schema,
  /** Fichiers binaires seulement. */
  sizeBytes: z.number().int().nonnegative().optional(),
  mimeType: z.string().optional(),
})
export type VersionEntry = z.infer<typeof versionEntrySchema>

/** `GET /projects/:id/versions/:versionId` : arborescence de la version et changements. */
export const versionDetailSchema = z.object({
  version: projectVersionSchema,
  authors: z.array(versionAuthorSchema),
  folders: z.array(z.string().min(1)),
  mainDocumentId: z.uuid().nullable(),
  /** Fichiers de la version, puis fichiers supprimés depuis la précédente (`deleted`). */
  entries: z.array(versionEntrySchema),
})
export type VersionDetail = z.infer<typeof versionDetailSchema>

/**
 * Segment du diff d'un document : texte inchangé, inséré ou supprimé depuis la version
 * précédente. `authorId` : compte dont la mise à jour Yjs a inséré (ou supprimé) ce texte ; null
 * pour un texte inchangé ou d'origine inconnue (état antérieur au journal des mises à jour).
 */
export const diffSegmentSchema = z.object({
  op: z.enum(['equal', 'insert', 'delete']),
  text: z.string(),
  authorId: z.uuid().nullable(),
})
export type DiffSegment = z.infer<typeof diffSegmentSchema>

/** `GET /projects/:id/versions/:versionId/documents/:documentId/diff`. */
export const documentDiffResponseSchema = z.object({
  documentId: z.uuid(),
  path: z.string().min(1),
  previousPath: z.string().min(1).nullable(),
  status: versionEntryStatusSchema,
  segments: z.array(diffSegmentSchema),
})
export type DocumentDiffResponse = z.infer<typeof documentDiffResponseSchema>

/** `PATCH /projects/:id/versions/:versionId` : nommer une version (null retire le label). */
export const updateVersionInputSchema = z.strictObject({
  label: z.string().trim().min(1).max(VERSION_LABEL_MAX_LENGTH).nullable(),
})
export type UpdateVersionInput = z.infer<typeof updateVersionInputSchema>

/**
 * `POST /projects/:id/versions/:versionId/restore` : tout le projet (texte, images et
 * arborescence), ou un seul fichier (`entryId` : document ou fichier binaire de la version).
 */
export const restoreVersionInputSchema = z.discriminatedUnion('scope', [
  z.strictObject({ scope: z.literal('project') }),
  z.strictObject({ scope: z.literal('entry'), entryId: z.uuid() }),
])
export type RestoreVersionInput = z.infer<typeof restoreVersionInputSchema>

export const restoreVersionResponseSchema = z.object({
  /** Version créée juste avant la restauration (l'état remplacé, rien n'est perdu). */
  backupVersionId: z.uuid(),
  /**
   * Version de l'état restauré (`restored`), créée tout de suite après ; null si l'état restauré
   * est identique à la sauvegarde, ou si sa création a échoué (le balayage la rattrape alors).
   */
  restoredVersionId: z.uuid().nullable(),
  restored: z.object({
    documents: z.number().int().nonnegative(),
    files: z.number().int().nonnegative(),
  }),
})
export type RestoreVersionResponse = z.infer<typeof restoreVersionResponseSchema>

// --- Stockage objet ---------------------------------------------------------------------------

export const VERSION_MANIFEST_VERSION = 1

/**
 * Manifeste d'une version (`<s3_prefix>manifest.json.gz`) : arborescence complète au moment de
 * la version. Le texte de chaque document est stocké compressé à part, adressé par son sha256
 * (`projects/{id}/history/texts/{sha256}.gz`) ; un binaire reste à sa clé d'origine, conservée
 * tant qu'une version y fait référence (table version_files).
 */
export const versionManifestSchema = z.object({
  v: z.literal(VERSION_MANIFEST_VERSION),
  mainDocumentId: z.uuid().nullable(),
  folders: z.array(z.string().min(1)),
  documents: z.array(z.object({ id: z.uuid(), path: z.string().min(1), sha256: sha256Schema })),
  files: z.array(
    z.object({
      id: z.uuid(),
      path: z.string().min(1),
      sha256: sha256Schema,
      sizeBytes: z.number().int().nonnegative(),
      mimeType: z.string().min(1),
      s3Key: z.string().min(1),
    }),
  ),
  entries: z.array(versionEntrySchema),
})
export type VersionManifest = z.infer<typeof versionManifestSchema>

// --- Routes internes du service temps réel ----------------------------------------------------

/**
 * `POST /internal/projects/:projectId/documents/:documentId/replace` : remplace le texte d'un
 * document (restauration) par une modification Yjs minimale, reçue par les clients connectés et
 * attribuée à `userId` dans le journal des mises à jour.
 */
export const replaceDocumentRequestSchema = z.object({
  content: z.string(),
  userId: z.uuid(),
})
export type ReplaceDocumentRequest = z.infer<typeof replaceDocumentRequestSchema>

export const replaceDocumentResponseSchema = z.object({
  /** Faux si le document avait déjà ce texte. */
  changed: z.boolean(),
})
export type ReplaceDocumentResponse = z.infer<typeof replaceDocumentResponseSchema>

/**
 * `POST /internal/projects/:projectId/updates/flush` : écrit tout de suite les mises à jour Yjs
 * en attente dans le journal (avant une version de compilation ou de restauration).
 */
export const flushUpdatesResponseSchema = z.object({
  flushed: z.number().int().nonnegative(),
})
export type FlushUpdatesResponse = z.infer<typeof flushUpdatesResponseSchema>
