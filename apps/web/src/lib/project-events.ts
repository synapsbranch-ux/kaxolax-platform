import {
  type ActiveBanner,
  type ChatMessageCreatedEvent,
  type CommentCreatedEvent,
  type CommentThreadUpdatedEvent,
  parseProjectEventMessage,
  type ProjectEvent,
  type RoleChangedMessage,
  roleChangedMessageSchema,
  type VersionCreatedEvent,
} from '@kaxolax/contracts'

/**
 * Messages sans état reçus du service temps réel : événements du projet (document meta) et
 * changement de rôle de sa propre connexion. Tout le reste (JSON invalide, version future, type
 * inconnu) est ignoré.
 */
export type RealtimeMessage =
  { kind: 'event'; event: ProjectEvent } | { kind: 'role'; message: RoleChangedMessage }

export function parseRealtimeMessage(payload: string): RealtimeMessage | null {
  const event = parseProjectEventMessage(payload)
  if (event !== null) return { kind: 'event', event: event.event }
  let value: unknown
  try {
    value = JSON.parse(payload)
  } catch {
    return null
  }
  const role = roleChangedMessageSchema.safeParse(value)
  return role.success ? { kind: 'role', message: role.data } : null
}

/** Effet d'un événement sur la page projet, pour l'utilisateur `selfId`. */
export type EventEffect =
  | { kind: 'refresh-tree' }
  | { kind: 'refresh-members' }
  /** Son propre rôle a changé (relire le projet) ou on a été retiré (vérifier l'accès). */
  | { kind: 'refresh-access' }
  | { kind: 'banners'; banners: ActiveBanner[] }
  /** Nouveau message du chat : transmis au chat (`chatFeed`). */
  | { kind: 'chat'; event: ChatMessageCreatedEvent }
  /** Commentaire créé ou fil modifié : transmis aux commentaires (`commentFeed`). */
  | { kind: 'comment'; event: CommentFeedEvent }
  /** Nouvelle version de l'historique : transmise au tiroir Historique (`historyFeed`). */
  | { kind: 'history'; event: VersionCreatedEvent }
  | { kind: 'none' }

/**
 * Ce que la page projet fait d'un événement. Les événements de compilation (tâche 14) sont
 * laissés aux composants qui les traitent.
 */
export function eventEffect(event: ProjectEvent, selfId: string | null): EventEffect {
  switch (event.type) {
    case 'tree.changed':
      return { kind: 'refresh-tree' }
    case 'member.added':
      return { kind: 'refresh-members' }
    case 'member.removed':
    case 'member.role-updated':
      return event.userId === selfId ? { kind: 'refresh-access' } : { kind: 'refresh-members' }
    case 'banner.changed':
      return { kind: 'banners', banners: event.banners }
    case 'chat.message-created':
      return { kind: 'chat', event }
    case 'comment.created':
    case 'comment.thread-updated':
      return { kind: 'comment', event }
    case 'version.created':
      return { kind: 'history', event }
    default:
      return { kind: 'none' }
  }
}

type BannerListener = (banners: ActiveBanner[]) => void
const bannerListeners = new Set<BannerListener>()

/**
 * Bannières reçues en direct (événement `banner.changed` du document meta) : la page projet les
 * publie, la bannière système (`SystemBanner`, layout de l'application) s'y abonne.
 */
export const bannerFeed = {
  publish(banners: ActiveBanner[]): void {
    for (const listener of [...bannerListeners]) listener(banners)
  },
  subscribe(listener: BannerListener): () => void {
    bannerListeners.add(listener)
    return () => {
      bannerListeners.delete(listener)
    }
  },
}

type ChatListener = (event: ChatMessageCreatedEvent) => void
const chatListeners = new Set<ChatListener>()

/**
 * Nouveaux messages du chat (événement `chat.message-created` du document meta) : la page projet
 * les publie, le chat de la sidebar (`useProjectChat`) s'y abonne et relit les messages suivants.
 */
export const chatFeed = {
  publish(event: ChatMessageCreatedEvent): void {
    for (const listener of [...chatListeners]) listener(event)
  },
  subscribe(listener: ChatListener): () => void {
    chatListeners.add(listener)
    return () => {
      chatListeners.delete(listener)
    }
  },
}

/** Événements des commentaires (tâche 7). */
export type CommentFeedEvent = CommentCreatedEvent | CommentThreadUpdatedEvent

type CommentListener = (event: CommentFeedEvent) => void
const commentListeners = new Set<CommentListener>()

/**
 * Commentaires créés et fils modifiés (document meta) : la page projet les publie, les
 * commentaires du projet (`useProjectComments`) s'y abonnent et relisent le fil concerné.
 */
export const commentFeed = {
  publish(event: CommentFeedEvent): void {
    for (const listener of [...commentListeners]) listener(event)
  },
  subscribe(listener: CommentListener): () => void {
    commentListeners.add(listener)
    return () => {
      commentListeners.delete(listener)
    }
  },
}

type HistoryListener = (event: VersionCreatedEvent) => void
const historyListeners = new Set<HistoryListener>()

/**
 * Nouvelles versions de l'historique (événement `version.created` du document meta) : la page
 * projet les publie, le tiroir Historique ouvert s'y abonne et relit la liste.
 */
export const historyFeed = {
  publish(event: VersionCreatedEvent): void {
    for (const listener of [...historyListeners]) listener(event)
  },
  subscribe(listener: HistoryListener): () => void {
    historyListeners.add(listener)
    return () => {
      historyListeners.delete(listener)
    }
  },
}
