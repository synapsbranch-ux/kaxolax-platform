import type { InvitationEmailMismatchError, TooManyInvitationsError } from '@kaxolax/contracts'
import { Exception } from '@adonisjs/core/exceptions'
import type { HttpContext } from '@adonisjs/core/http'

/**
 * Erreurs du partage (codes listés dans `SHARING_ERRORS` de `@kaxolax/contracts`). Celles qui
 * portent des données en plus du code (limite du plan, délai d'attente, indice d'email) rendent
 * elles-mêmes leur corps, identique en développement et en production.
 */

// Limite de collaborateurs du plan : `PlanLimitException` (#exceptions/plan_limit), commune à
// toutes les limites.

export class TooManyInvitationsException extends Exception {
  static override status = 429
  static override code = 'E_TOO_MANY_INVITATIONS'
  static override message = 'Too many invitation emails, try again later'

  /** Null : limite définitive (nombre maximal d'envois de cette invitation atteint). */
  constructor(readonly retryAfterSeconds: number | null) {
    super()
  }

  handle(_error: unknown, { response }: HttpContext) {
    const body: TooManyInvitationsError = {
      code: 'E_TOO_MANY_INVITATIONS',
      message: this.message,
      retryAfterSeconds: this.retryAfterSeconds,
    }
    if (this.retryAfterSeconds !== null) {
      response.header('retry-after', String(this.retryAfterSeconds))
    }
    response.status(429).send(body)
  }
}

export class InvitationEmailMismatchException extends Exception {
  static override status = 403
  static override code = 'E_INVITATION_EMAIL_MISMATCH'
  static override message =
    'This invitation was sent to another email address; sign in with that address to accept it'

  /** Email invité masqué (`a***@exemple.fr`) : la personne reconnaît son adresse. */
  constructor(readonly invitedEmailHint: string) {
    super()
  }

  handle(_error: unknown, { response }: HttpContext) {
    const body: InvitationEmailMismatchError = {
      code: 'E_INVITATION_EMAIL_MISMATCH',
      message: this.message,
      invitedEmailHint: this.invitedEmailHint,
    }
    response.status(403).send(body)
  }
}

export class AlreadyMemberException extends Exception {
  static override status = 409
  static override code = 'E_ALREADY_MEMBER'
  static override message = 'This person is already a member of the project'
}

export class InvitationNotFoundException extends Exception {
  static override status = 404
  static override code = 'E_INVITATION_NOT_FOUND'
  static override message = 'Invitation not found or no longer valid'
}

export class InvitationExpiredException extends Exception {
  static override status = 410
  static override code = 'E_INVITATION_EXPIRED'
  static override message = 'This invitation has expired; ask the project owner to send it again'
}

export class InvitationEmailFailedException extends Exception {
  static override status = 502
  static override code = 'E_INVITATION_EMAIL_FAILED'
  static override message =
    'The invitation email could not be sent; nothing was changed, try again later'
}

export class ShareLinkNotFoundException extends Exception {
  static override status = 404
  static override code = 'E_SHARE_LINK_NOT_FOUND'
  static override message = 'This share link does not exist or is no longer active'
}

export class MemberNotFoundException extends Exception {
  static override status = 404
  static override code = 'E_MEMBER_NOT_FOUND'
  static override message = 'Member not found in this project'
}

export class OwnerRoleLockedException extends Exception {
  static override status = 409
  static override code = 'E_OWNER_ROLE_LOCKED'
  static override message = 'The owner role only changes through an ownership transfer'
}

export class OwnerCannotLeaveException extends Exception {
  static override status = 409
  static override code = 'E_OWNER_CANNOT_LEAVE'
  static override message = 'Transfer the ownership before leaving the project'
}
