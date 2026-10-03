import * as Y from 'yjs'
import { createCommentAnchor } from './anchors.js'

/**
 * Conventions Yjs de Kaxolax, définies une seule fois : chaque document texte est un Y.Doc qui
 * contient un seul Y.Text nommé `content`.
 */
export const TEXT_FIELD = 'content'

const DOCUMENT_NAME = /^project:([0-9a-f-]{36}):doc:([0-9a-f-]{36})$/

/** Nom du document côté Hocuspocus. */
export function documentName(projectId: string, documentId: string): string {
  return `project:${projectId}:doc:${documentId}`
}

export function parseDocumentName(name: string): { projectId: string; documentId: string } | null {
  const match = DOCUMENT_NAME.exec(name)
  if (!match?.[1] || !match[2]) return null
  return { projectId: match[1], documentId: match[2] }
}

const META_DOCUMENT_NAME = /^project:([0-9a-f-]{36}):meta$/

/**
 * Nom du document meta d'un projet : il ne porte aucun contenu, seulement la présence globale
 * (awareness) et les événements du projet en messages sans état (`@kaxolax/contracts`, events).
 */
export function metaDocumentName(projectId: string): string {
  return `project:${projectId}:meta`
}

export function parseMetaDocumentName(name: string): { projectId: string } | null {
  const match = META_DOCUMENT_NAME.exec(name)
  if (!match?.[1]) return null
  return { projectId: match[1] }
}

const USER_CHANNEL_NAME = /^user:([0-9a-f-]{36})$/

/**
 * Canal temps réel d'un utilisateur (identifiant local), ouvert sur toutes les pages connectées :
 * sans contenu ni présence, il ne transporte que des messages sans état (bannière système).
 */
export function userChannelName(userId: string): string {
  return `user:${userId}`
}

export function parseUserChannelName(name: string): { userId: string } | null {
  const match = USER_CHANNEL_NAME.exec(name)
  if (!match?.[1]) return null
  return { userId: match[1] }
}

/** Document temps réel : document texte ou meta d'un projet, ou canal d'un utilisateur. */
export type RealtimeDocumentTarget =
  | { kind: 'text'; projectId: string; documentId: string }
  | { kind: 'meta'; projectId: string }
  | { kind: 'user'; userId: string }

/** Analyse un nom de document Hocuspocus, texte, meta ou canal ; null pour tout autre nom. */
export function parseRealtimeDocumentName(name: string): RealtimeDocumentTarget | null {
  const text = parseDocumentName(name)
  if (text) return { kind: 'text', ...text }
  const meta = parseMetaDocumentName(name)
  if (meta) return { kind: 'meta', ...meta }
  const user = parseUserChannelName(name)
  return user ? { kind: 'user', ...user } : null
}

export function textOf(doc: Y.Doc): string {
  return doc.getText(TEXT_FIELD).toJSON()
}

/** État Yjs initial d'un document contenant `text`. */
export function createDocumentState(text: string): Uint8Array {
  const doc = new Y.Doc()
  if (text !== '') doc.getText(TEXT_FIELD).insert(0, text)
  const state = Y.encodeStateAsUpdate(doc)
  doc.destroy()
  return state
}

/** Texte courant d'un état Yjs persisté. */
export function readDocumentText(state: Uint8Array | null): string {
  if (state === null || state.length === 0) return ''
  const doc = new Y.Doc()
  Y.applyUpdate(doc, state)
  const text = textOf(doc)
  doc.destroy()
  return text
}

/** Remplace tout le texte d'un état Yjs (import, restauration) et renvoie le nouvel état. */
export function replaceDocumentText(state: Uint8Array | null, text: string): Uint8Array {
  const doc = new Y.Doc()
  if (state !== null && state.length > 0) Y.applyUpdate(doc, state)
  const field = doc.getText(TEXT_FIELD)
  doc.transact(() => {
    field.delete(0, field.length)
    field.insert(0, text)
  })
  const next = Y.encodeStateAsUpdate(doc)
  doc.destroy()
  return next
}

/**
 * Ancre de commentaire de la plage [from, to[ du texte d'un état Yjs persisté (outils serveur,
 * tests) ; dans le navigateur, l'ancre est créée sur le document ouvert (`createCommentAnchor`).
 */
export function createStateAnchor(state: Uint8Array | null, from: number, to: number): Uint8Array {
  const doc = new Y.Doc()
  if (state !== null && state.length > 0) Y.applyUpdate(doc, state)
  try {
    return createCommentAnchor(doc.getText(TEXT_FIELD), from, to)
  } finally {
    doc.destroy()
  }
}

export * from './anchors.js'
export * from './history.js'
