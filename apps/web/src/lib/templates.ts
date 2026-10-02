/** Galerie de templates : libellés et liens (sans interface, testés unitairement). */
import type { Compiler, TemplateCategory, TemplateLanguage } from '@kaxolax/contracts'

export const CATEGORY_LABELS: Record<TemplateCategory, string> = {
  cv: 'CV',
  these: 'Thèse',
  article: 'Article',
  presentation: 'Présentation Beamer',
  lettre: 'Lettre',
  rapport: 'Rapport',
}

export const LANGUAGE_LABELS: Record<TemplateLanguage, string> = {
  fr: 'Français',
  en: 'Anglais',
}

export const COMPILER_LABELS: Record<Compiler, string> = {
  pdflatex: 'pdfLaTeX',
  xelatex: 'XeLaTeX',
  lualatex: 'LuaLaTeX',
}

/** Paramètre de la fiche d'un template qui rouvre la création après la connexion. */
export const USE_TEMPLATE_PARAM = 'use'

export function templateHref(id: string): string {
  return `/templates/${encodeURIComponent(id)}`
}

/** Page à retrouver après la connexion : la fiche, prête à créer le projet. */
export function templateResumeHref(id: string): string {
  return `${templateHref(id)}?${USE_TEMPLATE_PARAM}=1`
}
