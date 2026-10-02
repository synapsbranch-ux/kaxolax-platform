import type { WordCountSection, WordCountSectionKind } from '@kaxolax/contracts'
import { ApiError, errorMessage } from './api'

const LEVELS: Record<WordCountSectionKind, number> = {
  top: 0,
  part: 0,
  chapter: 1,
  section: 2,
  subsection: 3,
  subsubsection: 4,
  paragraph: 5,
  other: 5,
}

export const SECTION_KIND_LABELS: Record<WordCountSectionKind, string> = {
  top: 'Début du document',
  part: 'Partie',
  chapter: 'Chapitre',
  section: 'Section',
  subsection: 'Sous-section',
  subsubsection: 'Sous-sous-section',
  paragraph: 'Paragraphe',
  other: 'Autre',
}

/** Section à afficher, avec son retrait (0 = niveau le plus haut présent dans le document). */
export interface WordCountRow extends WordCountSection {
  depth: number
}

/**
 * Lignes du détail par section : retrait relatif au niveau le plus haut du document (un article
 * sans chapitre commence ses sections à 0). Le début du document (avant le premier titre) n'est
 * gardé que s'il contient des mots.
 */
export function wordCountRows(sections: readonly WordCountSection[]): WordCountRow[] {
  const kept = sections.filter((section) => section.kind !== 'top' || section.words > 0)
  const titled = kept.filter((section) => section.kind !== 'top')
  const top = titled.length === 0 ? 0 : Math.min(...titled.map((section) => LEVELS[section.kind]))
  return kept.map((section) => ({
    ...section,
    depth: section.kind === 'top' ? 0 : Math.min(4, Math.max(0, LEVELS[section.kind] - top)),
  }))
}

const NUMBER = new Intl.NumberFormat('fr-FR')

/** Nombre en français (`12 345`). */
export function formatCount(value: number): string {
  return NUMBER.format(value)
}

/** Titre d'une section affichable (texcount laisse parfois des commandes ou un titre vide). */
export function sectionTitle(section: WordCountSection): string {
  const title = section.title.replace(/\s+/g, ' ').trim()
  if (title !== '') return title
  return SECTION_KIND_LABELS[section.kind]
}

/** Message d'une erreur du comptage pour l'interface. */
export function wordCountErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    switch (error.code) {
      case 'E_NO_MAIN_DOCUMENT':
        return 'Choisissez d’abord le document principal du projet (menu de l’arborescence).'
      case 'E_COMPILE_UNAVAILABLE':
        return 'Le compilateur est indisponible ou en cours de démarrage. Réessayez dans un instant.'
      case 'E_WORD_COUNT_BUSY':
        return 'Un comptage est déjà en cours (autre document ou autre projet). Réessayez quand il sera terminé.'
      case 'E_WORD_COUNT_FAILED':
        return `Le comptage a échoué : ${error.message}`
      case 'E_NOT_FOUND':
        return 'Ce document n’existe plus.'
      default:
        return errorMessage(error)
    }
  }
  return `Comptage impossible (${errorMessage(error)}).`
}

/** Contexte passé à la boîte du compteur de mots (`host.openDialog`). */
export interface WordCountPayload {
  kind: 'word-count'
}

export function isWordCountPayload(value: unknown): value is WordCountPayload {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as Partial<WordCountPayload>).kind === 'word-count'
  )
}
