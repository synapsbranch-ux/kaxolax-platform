import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto'
import {
  type CreatePersonalAccessTokenInput,
  PERSONAL_ACCESS_TOKEN_CREATION_WINDOW_DAYS,
  PERSONAL_ACCESS_TOKEN_MAX_ACTIVE,
  PERSONAL_ACCESS_TOKEN_MAX_CREATED,
  PERSONAL_ACCESS_TOKEN_PREFIX,
  PERSONAL_ACCESS_TOKEN_RETENTION_DAYS,
  type PersonalAccessToken as PersonalAccessTokenSummary,
  personalAccessTokenSecretSchema,
  tokenScopeAllows,
  type TokenScope,
} from '@kaxolax/contracts'
import { Exception } from '@adonisjs/core/exceptions'
import logger from '@adonisjs/core/services/logger'
import db from '@adonisjs/lucid/services/db'
import { DateTime } from 'luxon'
import PersonalAccessToken from '#models/personal_access_token'
import User from '#models/user'
import { isoString, isoStringOrNull } from '#services/dates'
import { isUuid } from '#services/project_access'

/**
 * Jetons d'accès personnels (serveur MCP, tâche 7).
 *
 * - Secret : `kxp_` + identifiant public (12 caractères alphanumériques, unique) + `_` + 32 octets
 *   aléatoires en base64url. Affiché une seule fois, à la création ; la base garde le préfixe
 *   (`kxp_` + identifiant public) et le SHA-256 du secret complet.
 * - Vérification : recherche par préfixe, puis comparaison des hachages à temps constant
 *   (`timingSafeEqual`) ; jeton révoqué, expiré, ou compte supprimé ou banni : refusé.
 * - Portées `read`/`write` (`write` inclut `read`), projets autorisés ou tous ; l'appartenance au
 *   projet est revérifiée à chaque utilisation par l'appelant (`projectFor`).
 * - Bornes : 20 jetons actifs, 50 créations sur 30 jours glissants (révoqués compris) ; un jeton
 *   révoqué ou expiré depuis plus de 30 jours est supprimé à la création suivante. La liste
 *   reste ainsi bornée sans pagination.
 * - Journal : création et révocation (identifiant, préfixe, jamais le secret).
 */

export class PersonalAccessTokenNotFoundException extends Exception {
  static override status = 404
  static override code = 'E_TOKEN_NOT_FOUND'
  static override message = 'Personal access token not found'
}

export class PersonalAccessTokenLimitException extends Exception {
  static override status = 409
  static override code = 'E_TOKEN_LIMIT'
  static override message = `Revoke a token first: at most ${String(PERSONAL_ACCESS_TOKEN_MAX_ACTIVE)} active tokens per account`
}

export class PersonalAccessTokenRateLimitException extends Exception {
  static override status = 429
  static override code = 'E_TOKEN_RATE_LIMIT'
  static override message = `Too many tokens created: at most ${String(PERSONAL_ACCESS_TOKEN_MAX_CREATED)} per ${String(PERSONAL_ACCESS_TOKEN_CREATION_WINDOW_DAYS)} days`
}

export class PersonalAccessTokenInvalidProjectException extends Exception {
  static override status = 422
  static override code = 'E_TOKEN_INVALID_PROJECT'
  static override message = 'The token can only name projects you are a member of'
}

const ALPHANUMERIC = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
const PUBLIC_ID_LENGTH = 12

/** Identifiant public aléatoire (alphanumérique, tirage uniforme). */
function publicId(): string {
  let id = ''
  for (let index = 0; index < PUBLIC_ID_LENGTH; index++) {
    id += ALPHANUMERIC[randomInt(ALPHANUMERIC.length)] ?? ''
  }
  return id
}

function sha256(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest()
}

/** Préfixe affichable d'un secret bien formé (`kxp_` + identifiant public). */
function prefixOf(secret: string): string {
  return secret.slice(0, PERSONAL_ACCESS_TOKEN_PREFIX.length + PUBLIC_ID_LENGTH)
}

export function serializePersonalAccessToken(
  token: PersonalAccessToken,
): PersonalAccessTokenSummary {
  return {
    id: token.id,
    name: token.name,
    prefix: token.tokenPrefix,
    scopes: [...token.scopes],
    projectIds: token.projectIds === null ? null : [...token.projectIds],
    expiresAt: isoString(token.expiresAt),
    lastUsedAt: isoStringOrNull(token.lastUsedAt),
    revokedAt: isoStringOrNull(token.revokedAt),
    createdAt: isoString(token.createdAt),
  }
}

/**
 * Plus de lignes qu'un compte ne peut en garder : actifs d'avant la fenêtre des créations, plus
 * les créations de la fenêtre. Garde-fou de la liste (la purge la borne déjà).
 */
const LIST_LIMIT = PERSONAL_ACCESS_TOKEN_MAX_ACTIVE + PERSONAL_ACCESS_TOKEN_MAX_CREATED

/**
 * Jetons du compte, du plus récent au plus ancien : actifs, et révoqués ou expirés depuis moins
 * de `PERSONAL_ACCESS_TOKEN_RETENTION_DAYS` jours.
 */
export async function listPersonalAccessTokens(
  user: User,
  now: DateTime = DateTime.utc(),
): Promise<PersonalAccessToken[]> {
  const cutoff = now.minus({ days: PERSONAL_ACCESS_TOKEN_RETENTION_DAYS }).toJSDate()
  return PersonalAccessToken.query()
    .where('userId', user.id)
    .where('expiresAt', '>', cutoff)
    .where((query) => {
      void query.whereNull('revokedAt').orWhere('revokedAt', '>', cutoff)
    })
    .orderBy('createdAt', 'desc')
    .orderBy('id', 'desc')
    .limit(LIST_LIMIT)
}

/**
 * Crée un jeton et renvoie son secret (seule fois où il existe en clair). Purge d'abord les jetons
 * révoqués ou expirés depuis plus de `PERSONAL_ACCESS_TOKEN_RETENTION_DAYS` jours. Refuse au-delà
 * de `PERSONAL_ACCESS_TOKEN_MAX_CREATED` créations sur la fenêtre glissante (429), de
 * `PERSONAL_ACCESS_TOKEN_MAX_ACTIVE` jetons actifs (409) et pour un projet dont le compte n'est
 * pas membre (422). Un verrou consultatif par compte sérialise les créations simultanées.
 */
export async function createPersonalAccessToken(
  user: User,
  input: CreatePersonalAccessTokenInput,
  now: DateTime = DateTime.utc(),
): Promise<{ token: PersonalAccessToken; secret: string }> {
  return db.transaction(async (trx) => {
    await trx.rawQuery('SELECT pg_advisory_xact_lock(hashtextextended(?, 0))', [
      `personal-access-tokens:${user.id}`,
    ])
    const cutoff = now.minus({ days: PERSONAL_ACCESS_TOKEN_RETENTION_DAYS }).toJSDate()
    await trx
      .from('personal_access_tokens')
      .where('user_id', user.id)
      .where((query) => {
        void query.where('revoked_at', '<=', cutoff).orWhere('expires_at', '<=', cutoff)
      })
      .delete()
    const recent = (await trx
      .from('personal_access_tokens')
      .where('user_id', user.id)
      .where(
        'created_at',
        '>',
        now.minus({ days: PERSONAL_ACCESS_TOKEN_CREATION_WINDOW_DAYS }).toJSDate(),
      )
      .count('* as total')
      .first()) as { total: string | number } | null
    if (Number(recent?.total ?? 0) >= PERSONAL_ACCESS_TOKEN_MAX_CREATED) {
      throw new PersonalAccessTokenRateLimitException()
    }
    const active = (await trx
      .from('personal_access_tokens')
      .where('user_id', user.id)
      .whereNull('revoked_at')
      .where('expires_at', '>', now.toJSDate())
      .count('* as total')
      .first()) as { total: string | number } | null
    if (Number(active?.total ?? 0) >= PERSONAL_ACCESS_TOKEN_MAX_ACTIVE) {
      throw new PersonalAccessTokenLimitException()
    }
    if (input.projectIds !== null) {
      const ids = input.projectIds.filter(isUuid)
      const members = (await trx
        .from('project_members')
        .where('user_id', user.id)
        .whereIn('project_id', ids)
        .select('project_id')) as { project_id: string }[]
      if (ids.length !== input.projectIds.length || members.length !== ids.length) {
        throw new PersonalAccessTokenInvalidProjectException()
      }
    }
    const secret = `${PERSONAL_ACCESS_TOKEN_PREFIX}${publicId()}_${randomBytes(32).toString('base64url')}`
    const token = await PersonalAccessToken.create(
      {
        userId: user.id,
        name: input.name,
        tokenPrefix: prefixOf(secret),
        tokenHash: sha256(secret).toString('hex'),
        scopes: [...input.scopes],
        projectIds: input.projectIds === null ? null : [...input.projectIds],
        expiresAt: now.plus({ days: input.expiresInDays }),
        lastUsedAt: null,
        revokedAt: null,
      },
      { client: trx },
    )
    logger.info(
      { userId: user.id, tokenId: token.id, prefix: token.tokenPrefix, scopes: token.scopes },
      'personal access token created',
    )
    return { token, secret }
  })
}

/** Révoque un jeton du compte (idempotent). 404 pour un jeton inconnu ou d'un autre compte. */
export async function revokePersonalAccessToken(
  user: User,
  tokenId: string,
): Promise<PersonalAccessToken> {
  if (!isUuid(tokenId)) throw new PersonalAccessTokenNotFoundException()
  const token = await PersonalAccessToken.query().where({ id: tokenId, userId: user.id }).first()
  if (!token) throw new PersonalAccessTokenNotFoundException()
  if (token.revokedAt === null) {
    token.revokedAt = DateTime.utc()
    await token.save()
    logger.info(
      { userId: user.id, tokenId: token.id, prefix: token.tokenPrefix },
      'personal access token revoked',
    )
  }
  return token
}

/** Résultat d'une vérification : le jeton et son compte, ou la raison du refus. */
export type TokenVerification =
  | { status: 'valid'; token: PersonalAccessToken; user: User }
  | { status: 'invalid' | 'revoked' | 'expired' | 'account_disabled' }

/** Une utilisation n'est enregistrée qu'une fois par minute au plus (`last_used_at`). */
const LAST_USED_RESOLUTION_SECONDS = 60

/**
 * Vérifie un secret présenté (en-tête `Authorization: Bearer` du serveur MCP). Comparaison des
 * hachages à temps constant ; un secret mal formé ou inconnu donne `invalid`.
 */
export async function verifyPersonalAccessToken(
  secret: string,
  now: DateTime = DateTime.utc(),
): Promise<TokenVerification> {
  if (!personalAccessTokenSecretSchema.safeParse(secret).success) return { status: 'invalid' }
  const token = await PersonalAccessToken.findBy('tokenPrefix', prefixOf(secret))
  const presented = sha256(secret)
  // Toujours une comparaison, même sans jeton : durée identique pour un préfixe inconnu.
  const stored = token ? Buffer.from(token.tokenHash, 'hex') : Buffer.alloc(presented.length)
  const matches = stored.length === presented.length && timingSafeEqual(stored, presented)
  if (!token || !matches) return { status: 'invalid' }
  if (token.revokedAt !== null) return { status: 'revoked' }
  if (token.expiresAt <= now) return { status: 'expired' }
  const user = await User.find(token.userId)
  if (user?.deletedAt !== null || user.bannedAt !== null) {
    return { status: 'account_disabled' }
  }
  if (
    token.lastUsedAt === null ||
    now.diff(token.lastUsedAt, 'seconds').seconds >= LAST_USED_RESOLUTION_SECONDS
  ) {
    token.lastUsedAt = now
    await token.save()
  }
  return { status: 'valid', token, user }
}

/**
 * Vrai si le jeton autorise `scope` sur le projet (portées, liste des projets). L'appelant
 * vérifie aussi que le compte est toujours membre du projet (`projectFor`), avec son rôle.
 */
export function tokenAllows(
  token: Pick<PersonalAccessToken, 'scopes' | 'projectIds'>,
  projectId: string,
  scope: TokenScope,
): boolean {
  if (!tokenScopeAllows(token.scopes, scope)) return false
  return token.projectIds === null || token.projectIds.includes(projectId)
}
