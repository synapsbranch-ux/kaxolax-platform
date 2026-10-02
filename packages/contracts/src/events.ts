import { z } from 'zod'
import { activeBannerSchema } from './admin.js'
import { projectRoleSchema } from './realtime.js'

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

/** Nouveau commentaire (tâche 7) : le client relit le fil. */
export const commentCreatedEventSchema = z.object({
  type: z.literal('comment.created'),
  threadId: z.uuid(),
  commentId: z.uuid(),
  documentId: z.uuid(),
  authorId: z.uuid(),
})

/** Bannières système actives après un changement (diffusé à tous les clients connectés). */
export const bannerChangedEventSchema = z.object({
  type: z.literal('banner.changed'),
  banners: z.array(activeBannerSchema),
})

/**
 * Emplacement réservé à l'événement de compilation asynchrone (tâche 14) : seul `buildId` est fixé
 * ici, les autres champs passent tels quels jusqu'à ce que la tâche 14 précise le schéma.
 */
export const compileUpdatedEventSchema = z.looseObject({
  type: z.literal('compile.updated'),
  buildId: z.string().min(1).max(200),
})

export const projectEventSchema = z.discriminatedUnion('type', [
  treeChangedEventSchema,
  memberAddedEventSchema,
  memberRemovedEventSchema,
  memberRoleUpdatedEventSchema,
  chatMessageCreatedEventSchema,
  commentCreatedEventSchema,
  bannerChangedEventSchema,
  compileUpdatedEventSchema,
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
