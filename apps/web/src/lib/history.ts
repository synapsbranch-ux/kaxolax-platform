import {
  type DiffSegment,
  HISTORY_ERRORS,
  type ProjectVersion,
  presenceColorIndex,
  presenceCssColor,
  presenceCssColorLight,
  type VersionAuthor,
  type VersionEntry,
  type VersionKind,
} from '@kaxolax/contracts'
import { localizedErrorMessage, type ProjectTree } from './api'

/** Historique du projet (tiroir Historique) : regroupement, libellés et couleurs. */

export const VERSION_KIND_LABELS: Record<VersionKind, string> = {
  auto: 'Enregistrement automatique',
  compile: 'Compilation',
  restore: 'Avant restauration',
  restored: 'Après restauration',
}

export const ENTRY_STATUS_LABELS: Record<VersionEntry['status'], string> = {
  added: 'Ajouté',
  modified: 'Modifié',
  deleted: 'Supprimé',
  unchanged: 'Inchangé',
}

/** Nom affiché d'un auteur (compte anonymisé ou inconnu : « Auteur inconnu »). */
export function authorName(authors: ReadonlyMap<string, VersionAuthor>, id: string | null): string {
  if (id === null) return 'Auteur inconnu'
  return authors.get(id)?.name ?? 'Ancien membre'
}

/**
 * Couleurs d'un auteur, dérivées de son id comme celles de la présence (même couleur que son
 * curseur) ; gris pour un changement d'origine inconnue.
 */
export function authorColors(id: string | null): { color: string; background: string } {
  if (id === null) {
    return {
      color: 'var(--muted-foreground)',
      background: 'color-mix(in oklab, var(--muted-foreground) 20%, transparent)',
    }
  }
  const index = presenceColorIndex(id)
  return { color: presenceCssColor(index), background: presenceCssColorLight(index) }
}

/** Clé de jour (AAAA-MM-JJ, heure locale) d'une date ISO. */
export function dayKey(iso: string): string {
  const date = new Date(iso)
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${String(date.getFullYear())}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/** Libellé d'un jour : « Aujourd'hui », « Hier », sinon la date en toutes lettres. */
export function dayLabel(key: string, now: Date = new Date()): string {
  const today = dayKey(now.toISOString())
  const yesterday = new Date(now)
  yesterday.setDate(now.getDate() - 1)
  if (key === today) return "Aujourd'hui"
  if (key === dayKey(yesterday.toISOString())) return 'Hier'
  const [year, month, day] = key.split('-').map(Number)
  return new Date(year ?? 1970, (month ?? 1) - 1, day ?? 1).toLocaleDateString('fr-FR', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  })
}

/** Versions groupées par jour (heure locale), dans l'ordre reçu (du plus récent au plus ancien). */
export function groupByDay(
  versions: readonly ProjectVersion[],
): { day: string; versions: ProjectVersion[] }[] {
  const groups: { day: string; versions: ProjectVersion[] }[] = []
  for (const version of versions) {
    const day = dayKey(version.createdAt)
    const last = groups.at(-1)
    if (last?.day === day) last.versions.push(version)
    else groups.push({ day, versions: [version] })
  }
  return groups
}

export function timeLabel(iso: string): string {
  return new Date(iso).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })
}

/** Fichiers à montrer d'abord : ceux qui ont changé (ajoutés, modifiés, supprimés, déplacés). */
export function changedEntries(entries: readonly VersionEntry[]): VersionEntry[] {
  return entries.filter((entry) => entry.status !== 'unchanged' || entry.previousPath !== null)
}

/** Lignes et caractères ajoutés ou supprimés, par auteur (légende du diff). */
export function diffStats(
  segments: readonly DiffSegment[],
): { authorId: string | null; inserted: number; deleted: number }[] {
  const stats = new Map<string | null, { inserted: number; deleted: number }>()
  for (const segment of segments) {
    if (segment.op === 'equal') continue
    const entry = stats.get(segment.authorId) ?? { inserted: 0, deleted: 0 }
    if (segment.op === 'insert') entry.inserted += segment.text.length
    else entry.deleted += segment.text.length
    stats.set(segment.authorId, entry)
  }
  return [...stats].map(([authorId, counts]) => ({ authorId, ...counts }))
}

/**
 * Lignes d'un diff pour l'affichage : chaque ligne est une suite de segments (le texte d'un
 * segment est coupé aux retours à la ligne). Un long passage inchangé est replié autour des
 * changements (`context` lignes gardées de chaque côté) ; `null` marque un repli.
 */
export function diffLines(
  segments: readonly DiffSegment[],
  context = 3,
): ({ number: number; parts: DiffSegment[] } | null)[] {
  const lines: { parts: DiffSegment[]; changed: boolean }[] = [{ parts: [], changed: false }]
  for (const segment of segments) {
    const pieces = segment.text.split('\n')
    pieces.forEach((piece, index) => {
      const line = lines.at(-1)
      if (!line) return
      if (piece !== '') line.parts.push({ ...segment, text: piece })
      if (segment.op !== 'equal') line.changed = true
      if (index < pieces.length - 1) {
        // Retour à la ligne inséré ou supprimé : marqué sur la ligne qu'il termine.
        if (segment.op !== 'equal') line.parts.push({ ...segment, text: '↵' })
        lines.push({ parts: [], changed: false })
      }
    })
  }
  const keep = lines.map(() => false)
  lines.forEach((line, index) => {
    if (!line.changed) return
    for (let near = index - context; near <= index + context; near++) {
      if (near >= 0 && near < keep.length) keep[near] = true
    }
  })
  const anyChange = lines.some((line) => line.changed)
  const result: ({ number: number; parts: DiffSegment[] } | null)[] = []
  lines.forEach((line, index) => {
    if (anyChange && !keep[index]) {
      if (result.at(-1) !== null) result.push(null)
      return
    }
    result.push({ number: index + 1, parts: line.parts })
  })
  return result
}

const HISTORY_ERROR_MESSAGES: Record<string, string> = {
  [HISTORY_ERRORS.versionNotFound]: 'Cette version n’existe plus : elle a peut-être été purgée.',
  [HISTORY_ERRORS.entryNotFound]: 'Ce fichier ne fait pas partie de cette version.',
  [HISTORY_ERRORS.pathTaken]:
    'Un dossier occupe désormais le chemin de ce fichier : renommez-le ou déplacez-le, puis réessayez.',
  [HISTORY_ERRORS.realtimeUnavailable]:
    'Le texte restauré n’a pas pu être appliqué et rien n’a été modifié. Réessayez dans un instant.',
  [HISTORY_ERRORS.restoreIncomplete]:
    'La restauration a été interrompue : le projet n’est que partiellement restauré. Relancez-la ; la version « Avant restauration » garde l’état précédent.',
}

/** Message français d'une erreur du tiroir Historique. */
export function historyErrorMessage(error: unknown): string {
  return localizedErrorMessage(error, HISTORY_ERROR_MESSAGES)
}

/**
 * Ce qu'une restauration retire de l'arborescence actuelle (gardé dans la version de sauvegarde)
 * et le nombre de fils de commentaires perdus avec ces documents (ils ne font pas partie des
 * versions). Projet entier : documents et fichiers absents de la version ; un fichier supprimé
 * depuis : l'élément qui occupe aujourd'hui son chemin.
 */
export function restoreRemovals(
  target: { scope: 'project' } | { entry: Pick<VersionEntry, 'id' | 'path'> },
  versionEntries: readonly Pick<VersionEntry, 'id' | 'status'>[],
  tree: Pick<ProjectTree, 'documents' | 'files'>,
  threads: readonly { documentId: string }[],
): { paths: string[]; threads: number } {
  let documentIds: string[]
  let paths: string[]
  if ('entry' in target) {
    const { entry } = target
    const present =
      tree.documents.some((document) => document.id === entry.id) ||
      tree.files.some((file) => file.id === entry.id)
    const document = tree.documents.find((candidate) => candidate.path === entry.path)
    const file = tree.files.find((candidate) => candidate.path === entry.path)
    if (present) return { paths: [], threads: 0 }
    documentIds = document ? [document.id] : []
    paths = [document?.path, file?.path].filter((path): path is string => path !== undefined)
  } else {
    const kept = new Set(
      versionEntries.filter((entry) => entry.status !== 'deleted').map((entry) => entry.id),
    )
    const documents = tree.documents.filter((document) => !kept.has(document.id))
    const files = tree.files.filter((file) => !kept.has(file.id))
    documentIds = documents.map((document) => document.id)
    paths = [...documents, ...files].map((item) => item.path).sort()
  }
  const removed = new Set(documentIds)
  return { paths, threads: threads.filter((thread) => removed.has(thread.documentId)).length }
}
