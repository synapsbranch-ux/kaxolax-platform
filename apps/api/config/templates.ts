import app from '@adonisjs/core/services/app'
import env from '#start/env'

const catalogUrl = env.get('TEMPLATES_CATALOG_URL') ?? null

/** URL terminée par `/`, pour y résoudre les chemins relatifs du catalogue. */
function asBase(url: string): string {
  return url.endsWith('/') ? url : `${url}/`
}

/** Base des fichiers : `TEMPLATES_PUBLIC_URL`, sinon le dossier qui contient `templates.json`. */
function publicBase(): string | null {
  const explicit = env.get('TEMPLATES_PUBLIC_URL')
  if (explicit !== undefined) return asBase(explicit)
  return catalogUrl === null ? null : new URL('./', catalogUrl).toString()
}

/**
 * Galerie de templates : catalogue `templates.json` publié par le dépôt kaxolax-templates sur un
 * bucket R2 public (contrat v1, `@kaxolax/contracts` templates.ts). Sans `TEMPLATES_CATALOG_URL`,
 * hors production seulement, l'API sert le catalogue de démonstration `fixturePath` (mêmes
 * métadonnées que les dix templates de départ, fichiers non publiés) ; en production, la galerie
 * répond alors 503.
 */
const templatesConfig = {
  catalogUrl,
  publicUrl: publicBase(),
  /** Catalogue local de repli (développement, tests, CI). */
  fixturePath: app.inProduction ? null : app.makePath('resources/templates.fixture.json'),
  /**
   * Durée pendant laquelle le catalogue en mémoire est servi sans le redemander ; ensuite, requête
   * conditionnelle (ETag, Last-Modified). Même valeur que son `Cache-Control` (max-age=60).
   */
  freshMs: 60_000,
  /** Catalogue injoignable ou invalide : la dernière copie valide reste servie jusqu'à 24 h. */
  staleMaxMs: 24 * 60 * 60_000,
  /** Après un échec de rafraîchissement, délai avant le prochain essai. */
  retryMs: 30_000,
  fetchTimeoutMs: 10_000,
  /** Plafond du corps de `templates.json`. */
  maxCatalogBytes: 5 * 1024 * 1024,
  /** Téléchargement du zip d'un template (création d'un projet). */
  downloadTimeoutMs: 60_000,
}

export default templatesConfig
