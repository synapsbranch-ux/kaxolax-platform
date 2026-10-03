import {
  type ActiveBanner,
  type BroadcastEvent,
  broadcastEventSchema,
  type ChatMessageCreatedEvent,
  type CommentCreatedEvent,
  type CommentThreadUpdatedEvent,
  parseProjectEventMessage,
  type ProjectEvent,
  type RoleChangedMessage,
  roleChangedMessageSchema,
  type SuggestionCreatedEvent,
  type SuggestionDecidedEvent,
  type SuggestionUpdatedEvent,
  type VersionCreatedEvent,
  type SpellcheckLanguage,
  type ZoteroUpdatedEvent,
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

/**
 * Message sans état reçu sur le canal de l'utilisateur (`user:{id}`) : seuls les événements
 * diffusés à tous (bannière système) y sont attendus, tout le reste est ignoré.
 */
export function parseBroadcastMessage(payload: string): BroadcastEvent | null {
  const message = parseProjectEventMessage(payload)
  if (message === null) return null
  const event = broadcastEventSchema.safeParse(message.event)
  return event.success ? event.data : null
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
  /** Suggestion créée, modifiée, retirée ou décidée : transmise au suivi (`suggestionFeed`). */
  | { kind: 'suggestion'; event: SuggestionFeedEvent }
  /** Nouvelle version de l'historique : transmise au tiroir Historique (`historyFeed`). */
  | { kind: 'history'; event: VersionCreatedEvent }
  /** Réglages communs du projet à recopier (langue du correcteur). */
  | { kind: 'project'; changes: { spellcheckLanguage?: SpellcheckLanguage } }
  /** Lien Zotero du projet modifié ou synchronisé : transmis à `zoteroFeed` (lib/zotero.ts). */
  | { kind: 'zotero'; event: ZoteroUpdatedEvent }
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
    case 'suggestion.created':
    case 'suggestion.updated':
    case 'suggestion.decided':
      return { kind: 'suggestion', event }
    case 'version.created':
      return { kind: 'history', event }
    case 'project.updated':
      return event.spellcheckLanguage === undefined
        ? { kind: 'none' }
        : { kind: 'project', changes: { spellcheckLanguage: event.spellcheckLanguage } }
    case 'zotero.updated':
      return { kind: 'zotero', event }
    default:
      return { kind: 'none' }
  }
}

type BannerListener = (banners: ActiveBanner[]) => void
const bannerListeners = new Set<BannerListener>()

/**
 * Bannières reçues en direct par le document meta (événement `banner.changed`) : la page projet
 * les publie, la bannière système (`SystemBanner`, layout de l'application) s'y abonne, en plus
 * du canal de l'utilisateur ouvert sur toutes les pages (`useUserChannel`).
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

/** Événements du suivi des modifications. */
export type SuggestionFeedEvent =
  SuggestionCreatedEvent | SuggestionUpdatedEvent | SuggestionDecidedEvent

type SuggestionListener = (event: SuggestionFeedEvent) => void
const suggestionListeners = new Set<SuggestionListener>()

/**
 * Suggestions créées, modifiées, retirées ou décidées (document meta) : la page projet les
 * publie, les suggestions du projet (`useProjectSuggestions`) s'y abonnent.
 */
export const suggestionFeed = {
  publish(event: SuggestionFeedEvent): void {
    for (const listener of [...suggestionListeners]) listener(event)
  },
  subscribe(listener: SuggestionListener): () => void {
    suggestionListeners.add(listener)
    return () => {
      suggestionListeners.delete(listener)
    }
  },
}
