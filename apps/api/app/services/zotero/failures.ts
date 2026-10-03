import type { Exception } from '@adonisjs/core/exceptions'
import zoteroConfig from '#config/zotero'
import type ZoteroClient from '#services/zotero/client'
import { ZoteroExportTooLargeError, ZoteroHttpError } from '#services/zotero/client'
import {
  ZoteroBackoffException,
  ZoteroBibTooLargeException,
  ZoteroKeyInvalidException,
  ZoteroLibraryForbiddenException,
  ZoteroLibraryNotFoundException,
  ZoteroRequestFailedException,
} from '#services/zotero/errors'

/**
 * Erreur d'un appel à Zotero traduite pour le client : 403 (clé révoquée ou sans accès) →
 * `E_ZOTERO_KEY_INVALID`, 404 → `E_ZOTERO_LIBRARY_NOT_FOUND`, 429 et 503 → `E_ZOTERO_BACKOFF`
 * (`Retry-After`), export trop gros → `E_ZOTERO_BIB_TOO_LARGE`, le reste (réseau, 5xx, réponse
 * illisible) → `E_ZOTERO_REQUEST_FAILED`. Une autre erreur (déjà une exception de l'API) passe.
 */
export function zoteroFailure(error: unknown): unknown {
  if (error instanceof ZoteroExportTooLargeError) return new ZoteroBibTooLargeException()
  if (!(error instanceof ZoteroHttpError)) return error
  switch (error.status) {
    case 401:
    case 403:
      return new ZoteroKeyInvalidException()
    case 404:
      return new ZoteroLibraryNotFoundException()
    case 429:
    case 503:
      return new ZoteroBackoffException(
        error.retryAfterSeconds ?? zoteroConfig.defaultRetryAfterSeconds,
      )
    default:
      return new ZoteroRequestFailedException()
  }
}

/** Code `E_…` d'une exception de l'API (enregistré comme dernière erreur d'un lien). */
export function errorCodeOf(error: unknown): string {
  const code = (error as Partial<Exception> | null)?.code
  return typeof code === 'string' && code.startsWith('E_') ? code : 'E_ZOTERO_REQUEST_FAILED'
}

/**
 * Comme `zoteroFailure`, mais un 403 est d'abord expliqué : si la clé répond encore à
 * `GET /keys/current`, elle est valide et c'est l'accès à cette bibliothèque qui est refusé
 * (`E_ZOTERO_LIBRARY_FORBIDDEN` : droits réduits sur zotero.org), sinon elle a été révoquée
 * (`E_ZOTERO_KEY_INVALID`).
 */
export async function explainedZoteroFailure(
  zotero: ZoteroClient,
  apiKey: string,
  error: unknown,
): Promise<unknown> {
  if (error instanceof ZoteroHttpError && error.status === 403) {
    try {
      await zotero.keyInfo(apiKey)
      return new ZoteroLibraryForbiddenException()
    } catch {
      return new ZoteroKeyInvalidException()
    }
  }
  return zoteroFailure(error)
}
