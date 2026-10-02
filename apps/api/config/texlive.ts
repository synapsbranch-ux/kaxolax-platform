import app from '@adonisjs/core/services/app'
import env from '#start/env'

/**
 * Index des packages TeX Live servi par l'API (gestionnaire de packages, suggestions). Lu dans
 * le stockage objet, gardé en mémoire et revalidé par ETag ; sans bucket configuré, la fixture
 * sert en développement et en test, et les routes répondent 503 en production.
 */
const texliveConfig = {
  indexBucket: env.get('TEXLIVE_INDEX_BUCKET'),
  indexKey: env.get('TEXLIVE_INDEX_KEY') ?? 'texlive/2026/packages.json',
  fixturePath: app.makePath('resources/fixtures/texlive-packages.json'),
  allowFixture: !app.inProduction,
  /** Revalidation de l'index (la CI le publie avec Cache-Control: max-age=3600). */
  refreshIntervalMs: 60 * 60_000,
  /** Après un échec de lecture, l'index en mémoire sert encore ce délai avant un nouvel essai. */
  retryAfterErrorMs: 60_000,
  /** Cache-Control des réponses (navigateur), avec un ETag pour les revalider. */
  clientMaxAgeSeconds: 60 * 60,
}

export default texliveConfig
