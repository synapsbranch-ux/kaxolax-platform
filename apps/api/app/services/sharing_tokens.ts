import { createHash, createHmac, randomBytes } from 'node:crypto'
import env from '#start/env'

/**
 * Jetons du partage. Seul leur sha256 est stocké (`token_hash`) : une fuite de la base ne donne
 * aucun lien utilisable.
 *
 * - Invitation : 32 octets aléatoires, envoyés une seule fois par email.
 * - Lien de partage : HMAC-SHA256 (clé APP_KEY) de l'identifiant aléatoire du lien. Le
 *   propriétaire peut ainsi réafficher son lien sans qu'il soit stocké ; régénérer crée un
 *   nouvel identifiant, donc un nouveau jeton, et l'ancien cesse de fonctionner.
 */

/** Forme d'un jeton (43 caractères base64url, 256 bits) : un autre texte ne touche pas la base. */
const TOKEN_SHAPE = /^[A-Za-z0-9_-]{43}$/

export function isTokenShaped(token: string): boolean {
  return TOKEN_SHAPE.test(token)
}

export function newInvitationToken(): string {
  return randomBytes(32).toString('base64url')
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

export function shareLinkToken(linkId: string): string {
  return createHmac('sha256', env.get('APP_KEY').release())
    .update(`share-link:${linkId}`)
    .digest('base64url')
}
