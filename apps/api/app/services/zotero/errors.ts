import { ZOTERO_ERRORS } from '@kaxolax/contracts'
import { Exception } from '@adonisjs/core/exceptions'
import type { HttpContext } from '@adonisjs/core/http'

/** Erreurs de l'intégration Zotero (`ZOTERO_ERRORS` de @kaxolax/contracts). */

/** 503 : application OAuth non configurée (`ZOTERO_CLIENT_KEY`/`ZOTERO_CLIENT_SECRET`). */
export class ZoteroUnavailableException extends Exception {
  static override status = 503
  static override code = ZOTERO_ERRORS.unavailable
  static override message = 'The Zotero integration is not configured'
}

export class ZoteroNotConnectedException extends Exception {
  static override status = 409
  static override code = ZOTERO_ERRORS.notConnected
  static override message = 'Connect your Zotero account first'
}

export class ZoteroOAuthStateException extends Exception {
  static override status = 400
  static override code = ZOTERO_ERRORS.invalidOAuthState
  static override message = 'Unknown or expired Zotero authorization, start again'
}

export class ZoteroOAuthFailedException extends Exception {
  static override status = 502
  static override code = ZOTERO_ERRORS.oauthFailed
  static override message = 'Zotero refused the authorization'
}

export class ZoteroKeyInvalidException extends Exception {
  static override status = 409
  static override code = ZOTERO_ERRORS.keyInvalid
  static override message = 'The Zotero key was revoked, connect Zotero again'
}

export class ZoteroNotLinkedException extends Exception {
  static override status = 404
  static override code = ZOTERO_ERRORS.notLinked
  static override message = 'This project is not linked to a Zotero library'
}

export class ZoteroLibraryNotFoundException extends Exception {
  static override status = 404
  static override code = ZOTERO_ERRORS.libraryNotFound
  static override message = 'Zotero library or collection not found'
}

/** 403 : clé valide, mais sans accès à cette bibliothèque (droits choisis sur zotero.org). */
export class ZoteroLibraryForbiddenException extends Exception {
  static override status = 403
  static override code = ZOTERO_ERRORS.libraryForbidden
  static override message = 'The Zotero key has no access to this library'
}

export class ZoteroItemNotFoundException extends Exception {
  static override status = 404
  static override code = ZOTERO_ERRORS.itemNotFound
  static override message = 'Zotero item not found in the linked library or collection'
}

/** 422 : plafond des éléments ajoutés hors de la collection liée atteint. */
export class ZoteroPickedLimitException extends Exception {
  static override status = 422
  static override code = ZOTERO_ERRORS.pickedLimit
  static override message = 'Too many references added outside the linked collection'
}

/** 429 : demandes de connexion OAuth trop nombreuses ou trop rapprochées pour ce compte. */
export class ZoteroOAuthTooManyException extends Exception {
  static override status = 429
  static override code = ZOTERO_ERRORS.oauthTooMany
  static override message = 'Too many Zotero connection attempts, try again in a moment'
}

export class ZoteroRequestFailedException extends Exception {
  static override status = 502
  static override code = ZOTERO_ERRORS.requestFailed
  static override message = 'Zotero did not answer'
}

export class ZoteroSyncInProgressException extends Exception {
  static override status = 409
  static override code = ZOTERO_ERRORS.syncInProgress
  static override message = 'A Zotero synchronization is already running'
}

export class ZoteroBibTooLargeException extends Exception {
  static override status = 422
  static override code = ZOTERO_ERRORS.bibTooLarge
  static override message = 'The exported bibliography is larger than a text document can be'
}

export class ZoteroInvalidTargetException extends Exception {
  static override status = 422
  static override code = ZOTERO_ERRORS.invalidTarget
  static override message = 'The target must be a .bib document of the project'
}

/** 409 : « nouveau fichier » dont le nom est déjà pris (le choisir comme fichier existant). */
export class ZoteroTargetExistsException extends Exception {
  static override status = 409
  static override code = ZOTERO_ERRORS.targetExists
  static override message = 'A document with this name already exists, choose it explicitly'
}

/** 429 : Zotero a demandé une pause (`Backoff`, `Retry-After`) ; en-tête `Retry-After`. */
export class ZoteroBackoffException extends Exception {
  static override status = 429
  static override code = ZOTERO_ERRORS.backoff
  static override message = 'Zotero asked to slow down, try again later'

  constructor(readonly retryAfterSeconds: number) {
    super()
  }

  handle(_error: unknown, { response }: HttpContext) {
    response.header('retry-after', String(this.retryAfterSeconds))
    response.status(429).send({
      code: ZOTERO_ERRORS.backoff,
      message: this.message,
      retryAfterSeconds: this.retryAfterSeconds,
    })
  }
}

export class ZoteroRealtimeUnavailableException extends Exception {
  static override status = 503
  static override code = ZOTERO_ERRORS.realtimeUnavailable
  static override message = 'The bibliography update could not be confirmed, try again'
}
