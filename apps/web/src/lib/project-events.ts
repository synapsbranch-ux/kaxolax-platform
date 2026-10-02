import {
  type ActiveBanner,
  parseProjectEventMessage,
  type ProjectEvent,
  type RoleChangedMessage,
  roleChangedMessageSchema,
  type SpellcheckLanguage,
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
  /** Réglages communs du projet à recopier (langue du correcteur). */
  | { kind: 'project'; changes: { spellcheckLanguage?: SpellcheckLanguage } }
  | { kind: 'none' }

/**
 * Ce que la page projet fait d'un événement. Les événements des tâches 6, 7 et 14 (chat,
 * commentaires, compilation) sont laissés aux composants qui les traiteront.
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
    case 'project.updated':
      return event.spellcheckLanguage === undefined
        ? { kind: 'none' }
        : { kind: 'project', changes: { spellcheckLanguage: event.spellcheckLanguage } }
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
