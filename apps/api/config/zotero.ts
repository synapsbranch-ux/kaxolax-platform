import { ZOTERO_AUTO_SYNC_MINUTES } from '@kaxolax/contracts'
import env from '#start/env'

/**
 * Intégration Zotero (tâche 9) : application OAuth 1.0a (`ZOTERO_CLIENT_KEY`,
 * `ZOTERO_CLIENT_SECRET`, facultatives), adresses de Zotero, URL de rappel sous `APP_URL`, délais.
 */
const zoteroConfig = {
  clientKey: env.get('ZOTERO_CLIENT_KEY'),
  clientSecret: env.get('ZOTERO_CLIENT_SECRET'),
  /** Points d'accès OAuth (`/request`, `/authorize`, `/access`). */
  oauthBaseUrl: 'https://www.zotero.org/oauth',
  /** API Web v3. */
  apiBaseUrl: 'https://api.zotero.org',
  /** Page web qui reçoit le navigateur après l'autorisation et appelle l'API (même session). */
  callbackUrl: `${env.get('APP_URL').replace(/\/$/, '')}/integrations/zotero/callback`,
  /** Délai d'une requête vers Zotero (ms). */
  requestTimeoutMs: 20_000,
  /** Durée de vie d'une demande OAuth non terminée (minutes). */
  oauthRequestTtlMinutes: 15,
  /** Délai minimal entre deux demandes OAuth en cours d'un même compte (secondes). */
  oauthMinIntervalSeconds: 10,
  /** Synchro à l'ouverture du projet : au plus une fois par période (minutes). */
  autoSyncMinutes: ZOTERO_AUTO_SYNC_MINUTES,
  /** Une synchro « en cours » depuis plus longtemps (processus arrêté) peut être reprise. */
  staleSyncMinutes: 5,
  /** Pause appliquée quand Zotero répond 429 ou 503 sans `Retry-After` (secondes). */
  defaultRetryAfterSeconds: 60,
}

export default zoteroConfig
