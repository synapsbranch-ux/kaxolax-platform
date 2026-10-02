import {
  CHAT_ERRORS,
  type ChatMessage,
  type ChatSegment,
  mentionToken,
  parseChatBody,
  presenceUserFor,
  type ProjectMemberEntry,
} from '@kaxolax/contracts'
import { localizedErrorMessage, type ProjectTree, type TreeDocument } from './api'

/**
 * Logique du chat côté navigateur, sans React : regroupement des messages, segments affichables
 * (mentions et références `fichier:ligne` résolues), autocomplétion des mentions dans le champ de
 * saisie et encodage des mentions (`<@uuid>`) à l'envoi.
 */

/** Écart maximal entre deux messages d'un même auteur affichés sous un seul en-tête. */
export const GROUP_GAP_MS = 5 * 60_000
/** Au-delà, le badge de non-lus affiche `99+`. */
export const MAX_UNREAD_DISPLAY = 99
/** Membres proposés au plus par l'autocomplétion des mentions. */
export const MAX_MENTION_SUGGESTIONS = 8

/** Minuscules, sans accents, espaces réduits (comme `normalizeSearchText` de packages/ui). */
function normalizeSearchText(text: string): string {
  return text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/\s+/g, ' ').trim()
}

// --- Membres --------------------------------------------------------------------------------

/** Membre tel que le chat l'affiche : nom de présence (jamais l'email) et couleur dérivée de l'id. */
export interface ChatMember {
  id: string
  name: string
  avatarUrl: string | null
  color: string
}

export function chatMember(id: string, fullName: string | null, avatarUrl: string | null) {
  const user = presenceUserFor(id, fullName, avatarUrl)
  return { id, name: user.name, avatarUrl: user.avatarUrl, color: user.color } satisfies ChatMember
}

export function chatMembers(members: readonly ProjectMemberEntry[]): ChatMember[] {
  return members.map((member) =>
    chatMember(member.user.id, member.user.fullName, member.user.avatarUrl),
  )
}

// --- Regroupement ---------------------------------------------------------------------------

/** Messages consécutifs d'un même auteur, à moins de `GROUP_GAP_MS` l'un de l'autre. */
export interface ChatGroup {
  authorId: string
  messages: ChatMessage[]
}

/** Une journée (date locale) de messages. */
export interface ChatDay {
  /** `AAAA-MM-JJ` local. */
  key: string
  groups: ChatGroup[]
}

function dayKey(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${String(date.getFullYear())}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/** Regroupe des messages (du plus ancien au plus récent) par jour local, puis par auteur. */
export function groupMessages(messages: readonly ChatMessage[]): ChatDay[] {
  const days: ChatDay[] = []
  let previous: { at: number; authorId: string } | null = null
  for (const message of messages) {
    const at = new Date(message.createdAt)
    const key = dayKey(at)
    let day = days.at(-1)
    if (day?.key !== key) {
      day = { key, groups: [] }
      days.push(day)
      previous = null
    }
    const group = day.groups.at(-1)
    if (
      group !== undefined &&
      previous !== null &&
      previous.authorId === message.author.id &&
      at.getTime() - previous.at <= GROUP_GAP_MS
    ) {
      group.messages.push(message)
    } else {
      day.groups.push({ authorId: message.author.id, messages: [message] })
    }
    previous = { at: at.getTime(), authorId: message.author.id }
  }
  return days
}

/** Libellé d'une journée : « Aujourd'hui », « Hier », sinon la date en toutes lettres. */
export function dayLabel(key: string, now: Date = new Date()): string {
  if (key === dayKey(now)) return "Aujourd'hui"
  const yesterday = new Date(now)
  yesterday.setDate(now.getDate() - 1)
  if (key === dayKey(yesterday)) return 'Hier'
  const [year, month, day] = key.split('-').map(Number)
  const date = new Date(year ?? 1970, (month ?? 1) - 1, day ?? 1)
  return date.toLocaleDateString('fr-FR', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    ...(date.getFullYear() === now.getFullYear() ? {} : { year: 'numeric' }),
  })
}

/** Heure d'un message (`14:05`). */
export function timeLabel(iso: string): string {
  return new Date(iso).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })
}

/** Texte du badge de non-lus (null : pas de badge). */
export function unreadBadge(count: number): string | null {
  if (count <= 0) return null
  return count > MAX_UNREAD_DISPLAY ? `${String(MAX_UNREAD_DISPLAY)}+` : String(count)
}

/** Fusionne des messages (dédoublonnés par id), du plus ancien au plus récent. */
export function mergeMessages(
  current: readonly ChatMessage[],
  incoming: readonly ChatMessage[],
): ChatMessage[] {
  const byId = new Map(current.map((message) => [message.id, message]))
  for (const message of incoming) byId.set(message.id, message)
  return [...byId.values()].sort(
    (a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
  )
}

// --- Affichage ------------------------------------------------------------------------------

/**
 * Segment affichable : une référence n'est un lien que vers un document existant du projet,
 * sinon elle reste du texte ; une mention porte le membre (null : ancien membre).
 */
export type DisplaySegment =
  | { kind: 'text'; text: string }
  | { kind: 'mention'; userId: string; member: ChatMember | null }
  | { kind: 'file-ref'; text: string; document: TreeDocument; line: number }

/**
 * Document désigné par une référence : chemin exact dans le projet, sinon nom de fichier seul
 * s'il est unique (`intro.tex:3` pour `chapitres/intro.tex`).
 */
export function resolveFileRef(tree: ProjectTree | null, path: string): TreeDocument | null {
  if (tree === null) return null
  const normalized = path.replace(/^\.\//, '')
  const exact = tree.documents.find((document) => document.path === normalized)
  if (exact) return exact
  if (normalized.includes('/')) return null
  const byName = tree.documents.filter((document) => document.name === normalized)
  return byName.length === 1 ? (byName[0] ?? null) : null
}

export function displaySegments(
  body: string,
  tree: ProjectTree | null,
  members: ReadonlyMap<string, ChatMember>,
): DisplaySegment[] {
  const segments: DisplaySegment[] = []
  const pushText = (text: string) => {
    const previous = segments.at(-1)
    if (previous?.kind === 'text') previous.text += text
    else segments.push({ kind: 'text', text })
  }
  for (const segment of parseChatBody(body) satisfies ChatSegment[]) {
    if (segment.kind === 'text') pushText(segment.text)
    else if (segment.kind === 'mention')
      segments.push({
        kind: 'mention',
        userId: segment.userId,
        member: members.get(segment.userId) ?? null,
      })
    else {
      const document = resolveFileRef(tree, segment.path)
      if (document)
        segments.push({ kind: 'file-ref', text: segment.text, document, line: segment.line })
      else pushText(segment.text)
    }
  }
  return segments
}

/** Vrai si le message mentionne cet utilisateur (mise en valeur). */
export function mentions(body: string, userId: string): boolean {
  return body.toLowerCase().includes(mentionToken(userId))
}

// --- Saisie des mentions --------------------------------------------------------------------

/** Mention en cours de saisie : `@` en début de mot, puis le début d'un nom (sans espace). */
export interface MentionQuery {
  /** Position du `@`. */
  start: number
  query: string
}

const MENTION_QUERY_MAX_LENGTH = 40

/** Mention en cours de saisie juste avant le curseur, ou null. */
export function mentionQueryAt(text: string, caret: number): MentionQuery | null {
  const before = text.slice(0, caret)
  const at = before.lastIndexOf('@')
  if (at < 0) return null
  const query = before.slice(at + 1)
  if (query.length > MENTION_QUERY_MAX_LENGTH || /\s/.test(query)) return null
  // `@` en début de texte ou après une espace ou une ponctuation ouvrante (pas une adresse email).
  if (at > 0 && !/[\s([{"'«]/.test(before.charAt(at - 1))) return null
  return { start: at, query }
}

/**
 * Membres proposés pour une saisie : un mot de leur nom commence par la recherche (casse et
 * accents ignorés), soi-même exclu ; triés par nom.
 */
export function mentionSuggestions(
  members: readonly ChatMember[],
  query: string,
  selfId: string | null,
): ChatMember[] {
  const needle = normalizeSearchText(query)
  return members
    .filter((member) => member.id !== selfId)
    .filter(
      (member) =>
        needle === '' ||
        normalizeSearchText(member.name)
          .split(' ')
          .some((word) => word.startsWith(needle)),
    )
    .sort((a, b) => a.name.localeCompare(b.name, 'fr'))
    .slice(0, MAX_MENTION_SUGGESTIONS)
}

/** Mention choisie dans l'autocomplétion. */
export interface PickedMention {
  id: string
  name: string
}

/** Remplace la saisie `@requête` par `@Nom ` ; renvoie le texte et la nouvelle position du curseur. */
export function insertMention(
  text: string,
  query: MentionQuery,
  caret: number,
  name: string,
): { text: string; caret: number } {
  const inserted = `@${name} `
  return {
    text: text.slice(0, query.start) + inserted + text.slice(caret),
    caret: query.start + inserted.length,
  }
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Texte à envoyer : chaque `@Nom` choisi dans l'autocomplétion devient `<@uuid>` (homonymes dans
 * l'ordre des choix), ainsi qu'un `@Nom` tapé à la main s'il désigne un seul membre.
 */
export function encodeMentions(
  text: string,
  picked: readonly PickedMention[],
  members: readonly ChatMember[],
): string {
  const queues = new Map<string, string[]>()
  for (const mention of picked)
    queues.set(mention.name, [...(queues.get(mention.name) ?? []), mention.id])
  const byName = new Map<string, string[]>()
  for (const member of members)
    byName.set(member.name, [...(byName.get(member.name) ?? []), member.id])
  const names = [...new Set([...queues.keys(), ...byName.keys()])].sort(
    (a, b) => b.length - a.length,
  )
  if (names.length === 0) return text
  const pattern = new RegExp(`@(${names.map(escapeRegExp).join('|')})(?![\\p{L}\\p{N}_])`, 'gu')
  return text.replace(pattern, (whole, name: string) => {
    const id =
      queues.get(name)?.shift() ??
      (byName.get(name)?.length === 1 ? byName.get(name)?.[0] : undefined)
    return id === undefined ? whole : mentionToken(id)
  })
}

const CHAT_ERROR_MESSAGES: Record<string, string> = {
  [CHAT_ERRORS.rateLimited]: 'Trop de messages : réessayez dans un instant.',
  [CHAT_ERRORS.messageNotFound]: 'Ce message n’existe plus.',
}

/** Message français d'une erreur du chat. */
export function chatErrorMessage(error: unknown): string {
  return localizedErrorMessage(error, CHAT_ERROR_MESSAGES)
}
