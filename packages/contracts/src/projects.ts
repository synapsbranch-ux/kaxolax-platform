import { z } from 'zod'

/**
 * Langues du correcteur orthographique (dictionnaires Hunspell), choisies par projet. La liste
 * est aussi figée par une contrainte de la table projects : en ajouter une demande une migration.
 */
export const SPELLCHECK_LANGUAGES = ['en', 'fr'] as const
export const spellcheckLanguageSchema = z.enum(SPELLCHECK_LANGUAGES)
export type SpellcheckLanguage = z.infer<typeof spellcheckLanguageSchema>

export const DEFAULT_SPELLCHECK_LANGUAGE: SpellcheckLanguage = 'en'
