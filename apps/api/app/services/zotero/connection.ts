import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import {
  ZOTERO_ERRORS,
  type ZoteroCallbackQuery,
  type ZoteroCollection,
  type ZoteroConnection,
  type ZoteroConnectResponse,
  type ZoteroLibrary,
} from '@kaxolax/contracts'
import logger from '@adonisjs/core/services/logger'
import db from '@adonisjs/lucid/services/db'
import type { TransactionClientContract } from '@adonisjs/lucid/types/database'
import { DateTime } from 'luxon'
import zoteroConfig from '#config/zotero'
import type User from '#models/user'
import ZoteroAccount from '#models/zotero_account'
import ZoteroLink from '#models/zotero_link'
import ZoteroOAuthRequest from '#models/zotero_oauth_request'
import { isoString } from '#services/dates'
import type ZoteroClient from '#services/zotero/client'
import {
  canReadLibrary,
  type ZoteroKeyInfo,
  type ZoteroLibraryRef,
  type ZoteroResult,
} from '#services/zotero/client'
import {
  ZoteroBackoffException,
  ZoteroLibraryForbiddenException,
  ZoteroNotConnectedException,
  ZoteroOAuthStateException,
  ZoteroOAuthTooManyException,
} from '#services/zotero/errors'
import { explainedZoteroFailure, zoteroFailure } from '#services/zotero/failures'
import { memberCanEdit } from '#services/zotero/link_access'

/**
 * Connexion d'un compte Kaxolax à Zotero par OAuth 1.0a.
 *
 * 1. `startZoteroConnection` : jeton de requête obtenu de Zotero avec l'URL de rappel
 *    `APP_URL/integrations/zotero/callback?state=…`, enregistré (secret chiffré) avec le compte,
 *    la session Clerk (`sid`) et le hachage d'un `state` aléatoire ; renvoie l'URL d'autorisation.
 * 2. Zotero renvoie le navigateur sur la page web de rappel, qui appelle l'API avec la session
 *    Clerk : `completeZoteroConnection` exige le même compte, la même session, le même `state`
 *    (comparaison à temps constant) et une demande non expirée ; la demande est consommée avant
 *    l'échange (un rejeu échoue). C'est la protection anti-CSRF : un lien d'autorisation lancé
 *    par quelqu'un d'autre ne peut pas être terminé dans cette session.
 * 3. La clé d'API obtenue est vérifiée (`GET /keys/current`), chiffrée au repos et recopiée sur
 *    les liens de projet du compte pour le même compte Zotero (reconnexion), là où il a encore
 *    la permission `edit`. Les liens d'un autre compte Zotero perdent leur clé. L'ancienne clé,
 *    que plus aucun lien n'utilise, est ensuite révoquée chez Zotero (au mieux).
 *
 * Pauses demandées par Zotero (`Backoff`, `Retry-After`) lors des appels faits avec la clé du
 * compte (bibliothèques, collections, création d'un lien) : enregistrées sur le compte et
 * respectées (429 `E_ZOTERO_BACKOFF`).
 *
 * Droits : sur zotero.org, l'utilisateur peut réduire ceux de la clé (refuser la bibliothèque
 * personnelle, ne garder que certains groupes). Les bibliothèques proposées et celles qu'on peut
 * lier sont donc celles que `GET /keys/current` déclare lisibles ; un 403 d'une clé encore valide
 * se lit `E_ZOTERO_LIBRARY_FORBIDDEN`, pas « clé révoquée ».
 *
 * Concurrence : connexion et déconnexion d'un même compte verrouillent sa ligne `users` ; les
 * clés remplacées ou effacées sont révoquées chez Zotero une fois la transaction validée. Au
 * plus `MAX_PENDING_REQUESTS` demandes OAuth en cours par compte, une par session, espacées d'au
 * moins `oauthMinIntervalSeconds` (429 `E_ZOTERO_OAUTH_TOO_MANY`) : la clé d'application n'est
 * pas exposée à une boucle sur `POST …/connect`.
 *
 * Journal : début, fin et révocation (compte, `userID` Zotero), jamais de jeton ni de clé.
 */

/** Demandes OAuth non expirées au plus par compte (toutes sessions confondues). */
const MAX_PENDING_REQUESTS = 5

/** Verrouille la ligne du compte Kaxolax (sérialise connexion, déconnexion, demandes OAuth). */
async function lockUser(trx: TransactionClientContract, userId: string): Promise<void> {
  await trx.from('users').where('id', userId).forUpdate().select('id').first()
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

function sameHash(a: string, b: string): boolean {
  const left = Buffer.from(a, 'hex')
  const right = Buffer.from(b, 'hex')
  return left.length === right.length && timingSafeEqual(left, right)
}

export function serializeZoteroConnection(account: ZoteroAccount): ZoteroConnection {
  return {
    zoteroUserId: account.zoteroUserId,
    username: account.zoteroUsername,
    connectedAt: isoString(account.updatedAt),
  }
}

/** Compte Zotero connecté (null sinon, ou si sa clé ne se déchiffre plus). */
export async function zoteroAccountOf(user: User): Promise<ZoteroAccount | null> {
  const account = await ZoteroAccount.findBy('userId', user.id)
  return account?.apiKey ? account : null
}

/** Compte Zotero connecté avec sa clé, sinon 409 `E_ZOTERO_NOT_CONNECTED`. */
export async function connectedZoteroAccount(
  user: User,
): Promise<ZoteroAccount & { apiKey: string }> {
  const account = await zoteroAccountOf(user)
  if (!account?.apiKey) throw new ZoteroNotConnectedException()
  return account as ZoteroAccount & { apiKey: string }
}

/** Lève 429 `E_ZOTERO_BACKOFF` si Zotero a demandé une pause pour la clé du compte. */
export function assertAccountReady(account: ZoteroAccount, now: DateTime = DateTime.utc()): void {
  if (account.backoffUntil !== null && account.backoffUntil > now) {
    throw new ZoteroBackoffException(Math.ceil(account.backoffUntil.diff(now).as('seconds')))
  }
}

/** Enregistre sur le compte la pause demandée par Zotero (en secondes), si elle prolonge l'actuelle. */
export async function rememberAccountBackoff(
  accountId: string,
  seconds: number | null,
  now: DateTime = DateTime.utc(),
): Promise<DateTime | null> {
  if (seconds === null || seconds <= 0) return null
  const until = now.plus({ seconds })
  await ZoteroAccount.query()
    .where('id', accountId)
    .where((query) => {
      void query.whereNull('backoffUntil').orWhere('backoffUntil', '<', until.toJSDate())
    })
    .update({ backoffUntil: until.toJSDate() })
  return until
}

/**
 * Appel à Zotero avec la clé du compte : pause en cours respectée, pause demandée enregistrée
 * (`Backoff` d'une réponse réussie, `Retry-After` d'un 429 ou d'un 503), erreur traduite.
 */
export async function withAccountKey<T>(
  zotero: ZoteroClient,
  account: ZoteroAccount & { apiKey: string },
  call: () => Promise<ZoteroResult<T>>,
  now: DateTime = DateTime.utc(),
): Promise<T> {
  assertAccountReady(account, now)
  let result: ZoteroResult<T>
  try {
    result = await call()
  } catch (error) {
    const failure = await explainedZoteroFailure(zotero, account.apiKey, error)
    if (failure instanceof ZoteroBackoffException) {
      account.backoffUntil = await rememberAccountBackoff(
        account.id,
        failure.retryAfterSeconds,
        now,
      )
    }
    throw failure
  }
  const until = await rememberAccountBackoff(account.id, result.backoffSeconds, now)
  if (until !== null) account.backoffUntil = until
  return result.value
}

/**
 * Révoque des clés chez Zotero (`DELETE /keys/current`), au mieux : un échec est seulement
 * journalisé (la clé est de toute façon déjà effacée de Kaxolax). Renvoie le nombre révoqué.
 */
export async function revokeZoteroKeys(
  zotero: ZoteroClient,
  keys: Iterable<string | null>,
  context: Record<string, unknown>,
): Promise<number> {
  let revoked = 0
  for (const key of new Set(keys)) {
    if (key === null || key === '') continue
    try {
      await zotero.deleteKey(key)
      revoked++
    } catch (error) {
      logger.warn({ err: error, ...context }, 'zotero key revocation failed')
    }
  }
  return revoked
}

/** Démarre l'OAuth : URL de zotero.org où envoyer le navigateur. */
export async function startZoteroConnection(
  zotero: ZoteroClient,
  user: User,
  sessionId: string | null,
  now: DateTime = DateTime.utc(),
): Promise<ZoteroConnectResponse> {
  zotero.assertConfigured()
  // Sans session Clerk identifiée, la demande ne pourrait pas lui être liée.
  if (sessionId === null) throw new ZoteroOAuthStateException()
  const state = randomBytes(32).toString('base64url')
  const expiresAt = now.plus({ minutes: zoteroConfig.oauthRequestTtlMinutes })
  // Réservation avant d'appeler Zotero, sous le verrou du compte : la demande précédente de la
  // même session est remplacée, les limites valent aussi pour des appels simultanés.
  const reservation = await db.transaction(async (trx) => {
    await lockUser(trx, user.id)
    // Demandes expirées du compte : supprimées au passage (la table reste petite).
    await ZoteroOAuthRequest.query({ client: trx })
      .where('userId', user.id)
      .where('expiresAt', '<=', now.toJSDate())
      .delete()
    const pending = await ZoteroOAuthRequest.query({ client: trx })
      .where('userId', user.id)
      .orderBy('createdAt', 'desc')
    // Une demande terminée ou refusée est consommée : seules celles en cours comptent.
    const latest = pending[0]?.createdAt
    const others = pending.filter((request) => request.sessionId !== sessionId)
    if (
      others.length >= MAX_PENDING_REQUESTS ||
      (latest !== undefined &&
        now.diff(latest).as('seconds') < zoteroConfig.oauthMinIntervalSeconds)
    ) {
      logger.warn({ userId: user.id, pending: pending.length }, 'zotero connection throttled')
      throw new ZoteroOAuthTooManyException()
    }
    // Une demande en cours par session : la précédente est remplacée.
    await ZoteroOAuthRequest.query({ client: trx })
      .where('userId', user.id)
      .where('sessionId', sessionId)
      .delete()
    const placeholder = `reserved:${randomBytes(16).toString('hex')}`
    return ZoteroOAuthRequest.create(
      {
        userId: user.id,
        sessionId,
        requestToken: placeholder,
        requestTokenSecret: placeholder,
        stateHash: sha256Hex(state),
        expiresAt,
        createdAt: now,
      },
      { client: trx },
    )
  })
  const callback = new URL(zoteroConfig.callbackUrl)
  callback.searchParams.set('state', state)
  let token: string
  try {
    const issued = await zotero.requestToken(callback.toString())
    token = issued.token
    reservation.merge({ requestToken: issued.token, requestTokenSecret: issued.secret })
    await reservation.save()
  } catch (error) {
    // Échec chez Zotero : la réservation est rendue (l'utilisateur peut réessayer tout de suite).
    await ZoteroOAuthRequest.query().where('id', reservation.id).delete()
    throw error
  }
  logger.info({ userId: user.id }, 'zotero connection started')
  return { authorizeUrl: zotero.authorizeUrl(token), expiresAt: isoString(expiresAt) }
}

/** Termine l'OAuth (page de rappel du web, même session Clerk). */
export async function completeZoteroConnection(
  zotero: ZoteroClient,
  user: User,
  sessionId: string | null,
  query: ZoteroCallbackQuery,
  now: DateTime = DateTime.utc(),
): Promise<ZoteroConnection> {
  zotero.assertConfigured()
  // Consommée avant l'échange : une seconde tentative avec la même demande échoue.
  const pending = await db.transaction(async (trx) => {
    const request = await ZoteroOAuthRequest.query({ client: trx })
      .where('requestToken', query.oauth_token)
      .forUpdate()
      .first()
    if (!request) return null
    await request.useTransaction(trx).delete()
    return request
  })
  if (
    pending?.userId !== user.id ||
    sessionId === null ||
    pending.sessionId !== sessionId ||
    pending.expiresAt <= now ||
    !sameHash(pending.stateHash, sha256Hex(query.state)) ||
    !pending.requestTokenSecret
  ) {
    logger.warn({ userId: user.id, known: pending !== null }, 'zotero callback refused')
    throw new ZoteroOAuthStateException()
  }
  const access = await zotero.accessToken(
    query.oauth_token,
    pending.requestTokenSecret,
    query.oauth_verifier,
  )
  // La clé est-elle utilisable, et pour le compte annoncé ?
  let info
  try {
    info = (await zotero.keyInfo(access.apiKey)).value
  } catch (error) {
    // Clé que Kaxolax ne gardera pas : révoquée au mieux.
    await revokeZoteroKeys(zotero, [access.apiKey], { userId: user.id })
    throw zoteroFailure(error)
  }
  if (info.userId !== access.userId) {
    await revokeZoteroKeys(zotero, [access.apiKey], { userId: user.id })
    throw new ZoteroOAuthStateException()
  }

  // Sous le verrou du compte : deux rappels simultanés (deux onglets) se suivent, le second
  // remplace la clé du premier, qui est révoquée.
  const { account, staleKeys } = await db.transaction(async (trx) => {
    await lockUser(trx, user.id)
    const existing = await ZoteroAccount.query({ client: trx })
      .where('userId', user.id)
      .forUpdate()
      .first()
    // Clés remplacées : celle du compte et celles encore recopiées sur ses liens.
    const stale = new Set<string>()
    if (existing?.apiKey) stale.add(existing.apiKey)
    const saved = existing ?? new ZoteroAccount()
    saved.useTransaction(trx)
    saved.merge({
      userId: user.id,
      zoteroUserId: access.userId,
      zoteroUsername: info.username ?? access.username,
      apiKey: access.apiKey,
      // Nouvelle clé : la pause demandée pour l'ancienne ne s'applique plus.
      backoffUntil: existing?.zoteroUserId === access.userId ? existing.backoffUntil : null,
    })
    await saved.save()
    // Reconnexion : la nouvelle clé remplace l'ancienne sur ses liens au même compte Zotero, là
    // où il peut encore modifier le projet ; les liens d'un autre compte Zotero perdent la leur.
    const links = await ZoteroLink.query({ client: trx }).where('ownerId', user.id).forUpdate()
    for (const link of links) {
      if (link.apiKey !== null) stale.add(link.apiKey)
      link.useTransaction(trx)
      if (
        link.zoteroUserId === access.userId &&
        (await memberCanEdit(link.projectId, user.id, trx))
      ) {
        link.apiKey = access.apiKey
        if (link.lastError === ZOTERO_ERRORS.keyInvalid) link.lastError = null
      } else {
        link.apiKey = null
        link.lastError = ZOTERO_ERRORS.keyInvalid
      }
      await link.save()
    }
    stale.delete(access.apiKey)
    return { account: saved, staleKeys: [...stale] }
  })
  logger.info({ userId: user.id, zoteroUserId: access.userId }, 'zotero account connected')
  // Anciennes clés, que plus rien n'utilise : révoquées chez Zotero (au mieux).
  const revoked = await revokeZoteroKeys(zotero, staleKeys, { userId: user.id })
  if (revoked > 0) logger.info({ userId: user.id, revoked }, 'previous zotero keys revoked')
  return serializeZoteroConnection(account)
}

/**
 * Déconnecte Zotero : la clé est révoquée chez Zotero (`DELETE /keys/current`, au mieux : la
 * clé est effacée localement même si Zotero ne répond pas), puis le compte et la clé recopiée sur
 * ses liens de projet sont effacés (les liens restent, en erreur, jusqu'à un nouveau lien ou
 * une reconnexion). Idempotent.
 */
export async function disconnectZotero(zotero: ZoteroClient, user: User): Promise<void> {
  // Sous le verrou du compte : les clés effacées sont exactement celles révoquées ensuite (une
  // reconnexion simultanée passe avant ou après, jamais entre les deux).
  const removed = await db.transaction(async (trx) => {
    await lockUser(trx, user.id)
    const account = await ZoteroAccount.query({ client: trx })
      .where('userId', user.id)
      .forUpdate()
      .first()
    if (!account) return null
    const links = await ZoteroLink.query({ client: trx }).where('ownerId', user.id).forUpdate()
    await ZoteroLink.query({ client: trx })
      .where('ownerId', user.id)
      .update({ apiKey: null, lastError: ZOTERO_ERRORS.keyInvalid })
    await ZoteroOAuthRequest.query({ client: trx }).where('userId', user.id).delete()
    await account.useTransaction(trx).delete()
    return {
      zoteroUserId: account.zoteroUserId,
      keys: [account.apiKey, ...links.map((link) => link.apiKey)],
    }
  })
  if (removed === null) return
  const revoked = await revokeZoteroKeys(zotero, removed.keys, { userId: user.id })
  logger.info(
    { userId: user.id, zoteroUserId: removed.zoteroUserId, revokedAtZotero: revoked > 0 },
    'zotero account disconnected',
  )
}

/** Compte et droits actuels de la clé du compte (`GET /keys/current`). */
export async function accountKeyInfo(
  zotero: ZoteroClient,
  account: ZoteroAccount & { apiKey: string },
  now: DateTime = DateTime.utc(),
): Promise<ZoteroKeyInfo> {
  return withAccountKey(zotero, account, () => zotero.keyInfo(account.apiKey), now)
}

/**
 * Bibliothèques lisibles avec la clé : la bibliothèque personnelle (si la clé y a accès) puis
 * les groupes du compte que la clé peut lire.
 */
export async function zoteroLibraries(zotero: ZoteroClient, user: User): Promise<ZoteroLibrary[]> {
  zotero.assertConfigured()
  const account = await connectedZoteroAccount(user)
  const info = await accountKeyInfo(zotero, account)
  const groups = await withAccountKey(zotero, account, () =>
    zotero.groups(account.zoteroUserId, account.apiKey),
  )
  const personal: ZoteroLibrary[] = canReadLibrary(info, {
    type: 'user',
    id: account.zoteroUserId,
  })
    ? [{ type: 'user', id: account.zoteroUserId, name: 'Ma bibliothèque' }]
    : []
  return [
    ...personal,
    ...groups
      .filter((group) => canReadLibrary(info, { type: 'group', id: group.id }))
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((group) => ({ type: 'group' as const, id: group.id, name: group.name })),
  ]
}

/** Collections d'une bibliothèque du compte, triées par nom. */
export async function zoteroCollections(
  zotero: ZoteroClient,
  user: User,
  library: ZoteroLibraryRef,
): Promise<ZoteroCollection[]> {
  zotero.assertConfigured()
  const account = await connectedZoteroAccount(user)
  const info = await accountKeyInfo(zotero, account)
  if (!canReadLibrary(info, library)) throw new ZoteroLibraryForbiddenException()
  const value = await withAccountKey(zotero, account, () =>
    zotero.collections(library, account.apiKey),
  )
  return value
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((collection) => ({
      key: collection.key,
      name: collection.name,
      parentKey: collection.parentKey,
    }))
}
