import { z } from 'zod'
import { activeBannerSchema } from './admin.js'
import { buildStatusSchema } from './builds.js'
import { commentThreadUpdatedEventSchema } from './comments.js'
import { compileResultSchema } from './compile.js'
import { versionKindSchema } from './history.js'
import { zoteroLinkSchema } from './integrations.js'
import { spellcheckLanguageSchema } from './projects.js'
import { projectRoleSchema } from './realtime.js'
import {
  suggestionCreatedEventSchema,
  suggestionDecidedEventSchema,
  suggestionUpdatedEventSchema,
} from './suggestions.js'

/**
 * Événements du projet, diffusés en messages sans état (stateless Hocuspocus) sur le document meta
 * `project:{projectId}:meta` (voir `@kaxolax/collab`). L'API les publie par la route interne du
 * service temps réel, une fois sa transaction validée ; chaque client les valide à la réception
 * (`parseProjectEventMessage`) et ignore ce qu'il ne reconnaît pas.
 */

/** Version du format des messages : un client ignore une version qu'il ne connaît pas. */
export const PROJECT_EVENTS_VERSION = 1

/** Nombre maximal de changements détaillés dans un événement d'arborescence. */
export const MAX_TREE_CHANGES = 100

export const treeEntityTypeSchema = z.enum(['folder', 'document', 'file'])
export type TreeEntityType = z.infer<typeof treeEntityTypeSchema>

/**
 * Un changement de l'arborescence. `updated` couvre le renommage et le déplacement (nom et
 * dossier parent après le changement) ; `deleted` sur un dossier emporte tout son contenu.
 */
export const treeChangeSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('created'),
    entity: treeEntityTypeSchema,
    id: z.uuid(),
    parentId: z.uuid().nullable(),
    name: z.string().min(1),
  }),
  z.object({
    action: z.literal('updated'),
    entity: treeEntityTypeSchema,
    id: z.uuid(),
    parentId: z.uuid().nullable(),
    name: z.string().min(1),
  }),
  z.object({
    action: z.literal('deleted'),
    entity: treeEntityTypeSchema,
    id: z.uuid(),
  }),
])
export type TreeChange = z.infer<typeof treeChangeSchema>

/** Origine d'une modification de l'arborescence. */
export const treeChangeReasonSchema = z.enum([
  'create',
  'rename',
  'move',
  'delete',
  'upload',
  'import',
  'main-document',
  /** Restauration d'une version (tâche 8) : le client relit toute l'arborescence. */
  'restore',
])
export type TreeChangeReason = z.infer<typeof treeChangeReasonSchema>

/**
 * Arborescence modifiée, avec ce qui a changé. `mainDocumentId` n'est présent que si le document
 * principal a changé (raisons `main-document` et `import`). `changes` vide pour une autre raison,
 * ou trop de changements pour les détailler : le client relit toute l'arborescence.
 */
export const treeChangedEventSchema = z.object({
  type: z.literal('tree.changed'),
  reason: treeChangeReasonSchema,
  actorId: z.uuid().nullable(),
  changes: z.array(treeChangeSchema).max(MAX_TREE_CHANGES),
  mainDocumentId: z.uuid().nullable().optional(),
})
export type TreeChangedEvent = z.infer<typeof treeChangedEventSchema>

/** Un membre a rejoint le projet (invitation acceptée, lien de partage). */
export const memberAddedEventSchema = z.object({
  type: z.literal('member.added'),
  userId: z.uuid(),
  role: projectRoleSchema,
  actorId: z.uuid().nullable(),
})

/** Un membre a été retiré ou a quitté le projet. */
export const memberRemovedEventSchema = z.object({
  type: z.literal('member.removed'),
  userId: z.uuid(),
  actorId: z.uuid().nullable(),
})

/**
 * Le rôle d'un membre a changé (changement de rôle, transfert de propriété). Distinct du message
 * `member.role-changed` de `realtime.ts`, adressé à la seule connexion concernée.
 */
export const memberRoleUpdatedEventSchema = z.object({
  type: z.literal('member.role-updated'),
  userId: z.uuid(),
  role: projectRoleSchema,
  actorId: z.uuid().nullable(),
})

/** Nouveau message dans le chat du projet (tâche 6) : le client relit les messages. */
export const chatMessageCreatedEventSchema = z.object({
  type: z.literal('chat.message-created'),
  messageId: z.uuid(),
  authorId: z.uuid(),
})
export type ChatMessageCreatedEvent = z.infer<typeof chatMessageCreatedEventSchema>

/**
 * Nouveau commentaire (tâche 7) : nouveau fil (`commentId` est alors son premier message) ou
 * réponse. Le client relit le fil. Les autres changements d'un fil : `comment.thread-updated`
 * (comments.ts).
 */
export const commentCreatedEventSchema = z.object({
  type: z.literal('comment.created'),
  threadId: z.uuid(),
  commentId: z.uuid(),
  documentId: z.uuid(),
  authorId: z.uuid(),
})
export type CommentCreatedEvent = z.infer<typeof commentCreatedEventSchema>

/**
 * Nouvelle version dans l'historique (tâche 8) : le tiroir Historique ouvert relit la liste.
 * `actorId` : compte qui l'a déclenchée (compilation, restauration), null pour une version
 * automatique.
 */
export const versionCreatedEventSchema = z.object({
  type: z.literal('version.created'),
  versionId: z.uuid(),
  kind: versionKindSchema,
  actorId: z.uuid().nullable(),
})
export type VersionCreatedEvent = z.infer<typeof versionCreatedEventSchema>

/**
 * Réglages communs du projet modifiés (`PATCH /projects/:id`) : seuls les champs changés sont
 * présents, le client les recopie dans son projet (langue du correcteur partagée par les membres).
 */
export const projectUpdatedEventSchema = z.object({
  type: z.literal('project.updated'),
  actorId: z.uuid().nullable(),
  spellcheckLanguage: spellcheckLanguageSchema.optional(),
})
export type ProjectUpdatedEvent = z.infer<typeof projectUpdatedEventSchema>

/** Bannières système actives après un changement (diffusé à tous les clients connectés). */
export const bannerChangedEventSchema = z.object({
  type: z.literal('banner.changed'),
  banners: z.array(activeBannerSchema),
})

/**
 * Changement d'état d'une compilation asynchrone (tâche 14, voir `builds.ts`). Publié par l'API à
 * chaque étape (acceptée, rappel du Worker, annulation, compilation perdue) ; un client dédoublonne
 * par `buildId` et `status`, et garde le repli par sondage (`GET /projects/:id/builds/:buildId`).
 */
export const compileUpdatedEventSchema = z.object({
  type: z.literal('compile.updated'),
  buildId: z.uuid(),
  status: buildStatusSchema,
  /** Présent quand la compilation est terminée (URL présignées valables 1 heure). */
  result: compileResultSchema.nullable(),
  /**
   * Vrai quand le résultat, trop gros pour un événement (log très bavard), a été retiré
   * (`fitProjectEvent`) : le client le lit par `GET /projects/:id/builds/:buildId`.
   */
  resultOmitted: z.boolean().optional(),
})
export type CompileUpdatedEvent = z.infer<typeof compileUpdatedEventSchema>

/**
 * Lien Zotero du projet créé, modifié, synchronisé ou retiré (tâche 9) : le panneau Zotero ouvert
 * recopie `link` (null : plus de lien). `actorId` : membre à l'origine du changement.
 */
export const zoteroUpdatedEventSchema = z.object({
  type: z.literal('zotero.updated'),
  actorId: z.uuid().nullable(),
  link: zoteroLinkSchema.nullable(),
})
export type ZoteroUpdatedEvent = z.infer<typeof zoteroUpdatedEventSchema>

export const projectEventSchema = z.discriminatedUnion('type', [
  treeChangedEventSchema,
  memberAddedEventSchema,
  memberRemovedEventSchema,
  memberRoleUpdatedEventSchema,
  chatMessageCreatedEventSchema,
  commentCreatedEventSchema,
  commentThreadUpdatedEventSchema,
  bannerChangedEventSchema,
  compileUpdatedEventSchema,
  versionCreatedEventSchema,
  projectUpdatedEventSchema,
  suggestionCreatedEventSchema,
  suggestionUpdatedEventSchema,
  suggestionDecidedEventSchema,
  zoteroUpdatedEventSchema,
])
export type ProjectEvent = z.infer<typeof projectEventSchema>
export type ProjectEventType = ProjectEvent['type']

/** Événements diffusés à tous les clients connectés, tous projets confondus. */
export const broadcastEventSchema = bannerChangedEventSchema
export type BroadcastEvent = z.infer<typeof broadcastEventSchema>

/** Charge utile d'un message sans état du document meta. */
export const projectEventMessageSchema = z.object({
  kind: z.literal('project-event'),
  v: z.literal(PROJECT_EVENTS_VERSION),
  /** Date de publication par le service temps réel. */
  sentAt: z.iso.datetime(),
  event: projectEventSchema,
})
export type ProjectEventMessage = z.infer<typeof projectEventMessageSchema>

/** Construit le message sans état d'un événement (service temps réel). */
export function projectEventMessage(event: ProjectEvent, sentAt = new Date()): ProjectEventMessage {
  return { kind: 'project-event', v: PROJECT_EVENTS_VERSION, sentAt: sentAt.toISOString(), event }
}

/**
 * Lit un message sans état reçu du document meta : null si ce n'est pas un événement valide de la
 * version connue (JSON invalide, autre message comme `member.role-changed`, version future).
 */
export function parseProjectEventMessage(payload: string): ProjectEventMessage | null {
  let value: unknown
  try {
    value = JSON.parse(payload)
  } catch {
    return null
  }
  const parsed = projectEventMessageSchema.safeParse(value)
  return parsed.success ? parsed.data : null
}

/**
 * Taille maximale du corps de `POST /internal/projects/:id/events` et `POST /internal/events` du
 * service temps réel.
 */
export const MAX_PROJECT_EVENT_BYTES = 1024 * 1024

/**
 * Événement prêt à envoyer au service temps réel : un résultat de compilation qui ferait dépasser
 * `MAX_PROJECT_EVENT_BYTES` au corps de la requête est retiré (`resultOmitted`), le client le relit
 * par l'API. Les autres événements sont bornés par leur schéma et passent tels quels.
 */
export function fitProjectEvent(event: ProjectEvent): ProjectEvent {
  if (event.type !== 'compile.updated' || event.result === null) return event
  const body = JSON.stringify({ event } satisfies PublishProjectEventRequest)
  if (new TextEncoder().encode(body).byteLength <= MAX_PROJECT_EVENT_BYTES) return event
  return { ...event, result: null, resultOmitted: true }
}

/** POST /internal/projects/:id/events et POST /internal/events du service temps réel. */
export const publishProjectEventRequestSchema = z.object({ event: projectEventSchema })
export type PublishProjectEventRequest = z.infer<typeof publishProjectEventRequestSchema>

export const publishBroadcastEventRequestSchema = z.object({ event: broadcastEventSchema })
export type PublishBroadcastEventRequest = z.infer<typeof publishBroadcastEventRequestSchema>

/** Connexions de l'instance appelée qui ont reçu l'événement (les autres instances le relaient). */
export const publishEventResponseSchema = z.object({
  delivered: z.number().int().nonnegative(),
})
export type PublishEventResponse = z.infer<typeof publishEventResponseSchema>
