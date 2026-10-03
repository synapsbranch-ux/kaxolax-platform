import {
  type AddZoteroCitationResponse,
  MAX_TEXT_DOCUMENT_BYTES,
  ZOTERO_MAX_EXPORTED_ITEMS,
  ZOTERO_MAX_PICKED_ITEMS,
  ZOTERO_MAX_SUBCOLLECTIONS,
  ZOTERO_SEARCH_LIMIT,
  type ZoteroBibTarget,
  type ZoteroExportFormat,
  type ZoteroLibraryType,
  type ZoteroLink as ZoteroLinkSummary,
  type ZoteroSearchItem,
  type ZoteroSyncResponse,
  type ZoteroSyncTrigger,
} from '@kaxolax/contracts'
import { readDocumentText } from '@kaxolax/collab'
import logger from '@adonisjs/core/services/logger'
import db from '@adonisjs/lucid/services/db'
import type { TransactionClientContract } from '@adonisjs/lucid/types/database'
import { DateTime } from 'luxon'
import zoteroConfig from '#config/zotero'
import Document from '#models/document'
import User from '#models/user'
import ZoteroAccount from '#models/zotero_account'
import ZoteroLink from '#models/zotero_link'
import { isoString, isoStringOrNull } from '#services/dates'
import { assertStorageAvailable } from '#services/plan_enforcement'
import { projectFor } from '#services/project_access'
import type RealtimeClient from '#services/realtime_client'
import { buildTree, createDocument, touchProject } from '#services/tree_service'
import {
  appendBibEntry,
  assignCitationKey,
  bibKeys,
  firstBibEntry,
  type ItemEntry,
  managedBibliography,
  shortCreators,
  withCitationKey,
  yearOf,
} from '#services/zotero/bib'
import type ZoteroClient from '#services/zotero/client'
import {
  canReadLibrary,
  collectionSubtree,
  type ZoteroLibraryRef,
  type ZoteroResult,
} from '#services/zotero/client'
import {
  accountKeyInfo,
  connectedZoteroAccount,
  rememberAccountBackoff,
  withAccountKey,
} from '#services/zotero/connection'
import {
  ZoteroBackoffException,
  ZoteroBibTooLargeException,
  ZoteroInvalidTargetException,
  ZoteroItemNotFoundException,
  ZoteroKeyInvalidException,
  ZoteroLibraryForbiddenException,
  ZoteroLibraryNotFoundException,
  ZoteroNotLinkedException,
  ZoteroPickedLimitException,
  ZoteroRealtimeUnavailableException,
  ZoteroSyncInProgressException,
  ZoteroTargetExistsException,
  ZoteroUnavailableException,
} from '#services/zotero/errors'
import { errorCodeOf, explainedZoteroFailure } from '#services/zotero/failures'
import { dropZoteroKeyOf, memberCanEdit } from '#services/zotero/link_access'

/**
 * Lien d'un projet à une bibliothèque Zotero et synchronisation vers un `.bib` du projet.
 *
 * Permissions : lier, délier, synchroniser, chercher et insérer une citation demandent la
 * permission `edit` (éditeur, propriétaire). La clé utilisée est toujours celle du membre qui a
 * lié (copiée sur le lien) : tout éditeur peut rafraîchir avec elle, sans voir la clé ni accéder
 * à d'autres bibliothèques que celle choisie. Lien à une collection : les autres éditeurs ne
 * cherchent et n'ajoutent que dans cette collection et ses sous-collections (plus les éléments
 * déjà ajoutés) ; seul le membre qui a lié peut chercher et ajouter ailleurs dans sa
 * bibliothèque. Lien à toute la bibliothèque : tout éditeur y cherche (le formulaire le dit).
 * La clé n'est utilisable que tant que ce membre garde
 * `edit` sur le projet : retiré, parti, passé relecteur ou lecteur, déconnecté de Zotero ou
 * supprimé, sa clé est effacée du lien (`E_ZOTERO_KEY_INVALID`) et un éditeur doit le refaire
 * avec la sienne.
 *
 * Synchronisation : chaque élément de premier niveau de la collection et de ses
 * sous-collections (ou de toute la bibliothèque), plus les éléments ajoutés hors collection par
 * le sélecteur, exporté seul en
 * `biblatex` ou `bibtex` ; le `.bib` est écrit en entier par le service temps réel (modification
 * Yjs minimale, attribuée au membre qui synchronise : historique et clients connectés), après
 * vérification du stockage du plan. Les clés de citation sont suivies par élément Zotero (clé
 * d'élément) : deux éléments distincts n'ont jamais la même clé (suffixe a, b…), et un élément
 * garde la sienne d'une synchro à l'autre. À l'ouverture du projet (`open`), au plus une
 * tentative par `ZOTERO_AUTO_SYNC_MINUTES`, avec `If-Modified-Since-Version` : une bibliothèque
 * inchangée ne coûte qu'une requête et n'écrit rien. À la demande (`manual`), export complet ; le
 * même texte n'est pas réécrit (idempotent). Les pauses demandées par Zotero (`Backoff`,
 * `Retry-After`) sont enregistrées sur le lien et sur le compte du membre qui a lié, et
 * respectées.
 *
 * Concurrence : une seule synchro à la fois par lien (réservation en base, reprise possible après
 * `staleSyncMinutes`). Aucun appel à Zotero sous verrou. La fin d'une synchro (réécriture du
 * `.bib` par le service temps réel) se fait sous le verrou de la ligne du lien (`FOR UPDATE`),
 * une fois exportés tous les éléments choisis entre-temps (sinon nouvelle passe hors verrou).
 * Un ajout de citation enregistre sa clé (et l'élément choisi) sous ce verrou, valide, puis
 * ajoute l'entrée à la fin du `.bib` (insertion seule côté temps réel, idempotente) : une
 * frappe concurrente n'est pas écrasée, et une synchro qui suit l'ajout le garde. Une synchro
 * dont le lien a été refait ou supprimé pendant ses appels à Zotero n'écrit rien et n'annonce
 * rien.
 *
 * Clés de citation : uniques dans le `.bib` lié et différentes de celles des autres `.bib` du
 * projet pour toute clé nouvellement attribuée.
 */

export interface ZoteroDependencies {
  zotero: ZoteroClient
  realtime: RealtimeClient
}

/** Passes au plus d'une synchro dont des éléments sont choisis pendant ses appels à Zotero. */
const MAX_SYNC_PASSES = 4
/** Résultats demandés à Zotero quand la recherche est filtrée par collection. */
const SCOPED_SEARCH_LIMIT = 100

function libraryOf(link: ZoteroLink): ZoteroLibraryRef {
  return { type: link.libraryType, id: link.libraryId }
}

/** Collections du lien (la collection liée et ses sous-collections), null : toute la bibliothèque. */
function scopeOf(link: ZoteroLink): ReadonlySet<string> | null {
  if (link.collectionKey === null) return null
  return new Set(link.collectionScope.length > 0 ? link.collectionScope : [link.collectionKey])
}

/**
 * Collections où ce membre peut chercher et ajouter avec la clé du lien : null (toute la
 * bibliothèque) pour le membre qui a lié ou un lien à toute la bibliothèque.
 */
function scopeFor(link: ZoteroLink, user: User): ReadonlySet<string> | null {
  return link.ownerId === user.id ? null : scopeOf(link)
}

/**
 * Clés des entrées des autres `.bib` du projet : texte courant s'il est donné (`live`, par
 * document), sinon état enregistré.
 */
async function otherBibKeys(
  projectId: string,
  linkedDocumentId: string,
  live: ReadonlyMap<string, string> | null,
  trx?: TransactionClientContract,
): Promise<Set<string>> {
  const documents = await Document.query({ client: trx })
    .where('projectId', projectId)
    .whereNot('id', linkedDocumentId)
    .whereRaw('lower(name) like ?', ['%.bib'])
  const keys = new Set<string>()
  for (const document of documents) {
    const text =
      live?.get(document.id) ??
      readDocumentText(document.yjsState ? new Uint8Array(document.yjsState) : null)
    for (const key of bibKeys(text)) keys.add(key)
  }
  return keys
}

export async function serializeZoteroLink(link: ZoteroLink): Promise<ZoteroLinkSummary> {
  const owner = await User.find(link.ownerId)
  const tree = link.documentId === null ? null : await buildTree(link.projectId)
  const document = tree?.documents.find((entry) => entry.id === link.documentId)
  return {
    id: link.id,
    projectId: link.projectId,
    ownerId: link.ownerId,
    ownerName: owner ? (owner.fullName ?? owner.email) : null,
    libraryType: link.libraryType,
    libraryId: link.libraryId,
    libraryName: link.libraryName,
    collectionKey: link.collectionKey,
    collectionName: link.collectionName,
    documentId: link.documentId,
    documentPath: document?.path ?? null,
    exportFormat: link.exportFormat,
    syncStatus: link.syncStatus,
    lastSyncedAt: isoStringOrNull(link.lastSyncedAt),
    lastLibraryVersion: link.lastLibraryVersion,
    lastError: link.lastError,
    backoffUntil: isoStringOrNull(link.backoffUntil),
    hasKey: link.apiKey !== null,
    createdAt: isoString(link.createdAt),
  }
}

/** Publie l'état du lien aux clients connectés au projet (au mieux). */
async function announce(
  realtime: RealtimeClient,
  projectId: string,
  actorId: string | null,
  link: ZoteroLink | null,
): Promise<ZoteroLinkSummary | null> {
  const summary = link === null ? null : await serializeZoteroLink(link)
  await realtime.publishProjectEvent(projectId, {
    type: 'zotero.updated',
    actorId,
    link: summary,
  })
  return summary
}

/** Lien du projet (lecture : tout membre). */
export async function projectZoteroLink(
  user: User,
  projectId: string,
): Promise<ZoteroLinkSummary | null> {
  const { project } = await projectFor(user, projectId, 'read')
  const link = await ZoteroLink.findBy('projectId', project.id)
  return link === null ? null : serializeZoteroLink(link)
}

/** Compte Zotero connecté du membre qui a lié, s'il s'agit du même compte Zotero (même clé). */
function ownerAccountQuery(link: ZoteroLink) {
  return ZoteroAccount.query()
    .where('userId', link.ownerId)
    .where('zoteroUserId', link.zoteroUserId ?? '')
}

/** Fin de la pause en cours : celle du lien, ou celle du compte de son propriétaire. */
async function activeBackoff(link: ZoteroLink, now: DateTime): Promise<DateTime | null> {
  const account = await ownerAccountQuery(link).first()
  const candidates = [link.backoffUntil, account?.backoffUntil ?? null].filter(
    (until): until is DateTime => until !== null && until > now,
  )
  return candidates.reduce<DateTime | null>(
    (latest, until) => (latest === null || until > latest ? until : latest),
    null,
  )
}

/**
 * Lien du projet, avec la clé de son propriétaire, sinon l'erreur adaptée. Revérifie que le
 * membre qui a lié peut toujours modifier le projet (sinon sa clé est effacée du lien).
 */
async function usableLink(
  deps: ZoteroDependencies,
  projectId: string,
  now: DateTime,
): Promise<ZoteroLink & { apiKey: string }> {
  if (!deps.zotero.configured) throw new ZoteroUnavailableException()
  const link = await ZoteroLink.findBy('projectId', projectId)
  if (!link) throw new ZoteroNotLinkedException()
  if (link.apiKey === null) throw new ZoteroKeyInvalidException()
  if (!(await memberCanEdit(link.projectId, link.ownerId))) {
    await dropZoteroKeyOf(link.projectId, link.ownerId)
    throw new ZoteroKeyInvalidException()
  }
  const until = await activeBackoff(link, now)
  if (until !== null) {
    throw new ZoteroBackoffException(Math.ceil(until.diff(now).as('seconds')))
  }
  return link as ZoteroLink & { apiKey: string }
}

/**
 * Pause demandée par Zotero (`Backoff` ou `Retry-After`), enregistrée sur le lien et sur le
 * compte de son propriétaire (même clé).
 */
async function rememberBackoff(link: ZoteroLink, seconds: number | null, now: DateTime) {
  if (seconds === null || seconds <= 0) return
  await ZoteroLink.query()
    .where('id', link.id)
    .update({ backoffUntil: now.plus({ seconds }).toJSDate() })
  const account = await ownerAccountQuery(link).first()
  if (account) await rememberAccountBackoff(account.id, seconds, now)
}

/** Appel à Zotero avec la clé du lien : pause enregistrée, erreur traduite. */
async function withLinkKey<T>(
  deps: ZoteroDependencies,
  link: ZoteroLink & { apiKey: string },
  now: DateTime,
  call: () => Promise<ZoteroResult<T>>,
): Promise<T> {
  try {
    const result = await call()
    await rememberBackoff(link, result.backoffSeconds, now)
    return result.value
  } catch (error) {
    const failure = await explainedZoteroFailure(deps.zotero, link.apiKey, error)
    if (failure instanceof ZoteroBackoffException) {
      await rememberBackoff(link, failure.retryAfterSeconds, now)
    }
    throw failure
  }
}

/**
 * Document `.bib` cible : existant (vérifié), ou créé à ce nom dans ce dossier. « Nouveau
 * fichier » dont le nom est déjà pris : refusé (409), sauf s'il s'agit du `.bib` déjà lié.
 */
async function resolveTarget(
  trx: TransactionClientContract,
  projectId: string,
  ownerId: string,
  user: User,
  target: ZoteroBibTarget,
  linkedDocumentId: string | null,
): Promise<{ document: Document; created: boolean }> {
  if (target.kind === 'existing') {
    const document = await Document.query({ client: trx })
      .where({ id: target.documentId, projectId })
      .first()
    if (!document?.name.toLowerCase().endsWith('.bib')) throw new ZoteroInvalidTargetException()
    return { document, created: false }
  }
  const query = Document.query({ client: trx }).where({ projectId, name: target.name })
  if (target.folderId === null) void query.whereNull('folderId')
  else void query.where('folderId', target.folderId)
  const existing = await query.first()
  if (existing) {
    // Son contenu serait remplacé par l'export : il faut le choisir explicitement.
    if (existing.id !== linkedDocumentId) throw new ZoteroTargetExistsException()
    return { document: existing, created: false }
  }
  await assertStorageAvailable(ownerId, 0, { requester: user, trx })
  const document = await createDocument(trx, projectId, {
    name: target.name,
    folderId: target.folderId,
    content: '',
    authorId: user.id,
  })
  return { document, created: true }
}

/**
 * Lie le projet (ou change son lien) avec la clé du compte Zotero connecté, puis synchronise
 * (une erreur de cette première synchro reste sur le lien, le lien est gardé). Si Zotero a
 * demandé une pause, le lien est enregistré et la première synchro attend.
 */
export async function linkProjectToZotero(
  deps: ZoteroDependencies,
  user: User,
  projectId: string,
  input: {
    libraryType: ZoteroLibraryType
    libraryId: string
    collectionKey: string | null
    target: ZoteroBibTarget
    exportFormat: ZoteroExportFormat
  },
  now: DateTime = DateTime.utc(),
): Promise<ZoteroLinkSummary> {
  const { project } = await projectFor(user, projectId, 'edit')
  deps.zotero.assertConfigured()
  const account = await connectedZoteroAccount(user)
  const library: ZoteroLibraryRef = { type: input.libraryType, id: input.libraryId }

  // La bibliothèque et la collection doivent être lisibles avec la clé de ce compte, d'après les
  // droits que l'utilisateur lui a réellement accordés sur zotero.org.
  let libraryName: string
  let collectionName: string | null = null
  let collectionScope: string[] = []
  if (library.type === 'user' && library.id !== account.zoteroUserId) {
    throw new ZoteroLibraryNotFoundException()
  }
  const info = await accountKeyInfo(deps.zotero, account, now)
  if (library.type === 'user') {
    if (!canReadLibrary(info, library)) throw new ZoteroLibraryForbiddenException()
    libraryName =
      account.zoteroUsername === null
        ? 'Bibliothèque personnelle'
        : `Bibliothèque de ${account.zoteroUsername}`
  } else {
    const groups = await withAccountKey(
      deps.zotero,
      account,
      () => deps.zotero.groups(account.zoteroUserId, account.apiKey),
      now,
    )
    const group = groups.find((entry) => entry.id === library.id)
    if (!group) throw new ZoteroLibraryNotFoundException()
    if (!canReadLibrary(info, library)) throw new ZoteroLibraryForbiddenException()
    libraryName = group.name
  }
  if (input.collectionKey !== null) {
    const collections = await withAccountKey(
      deps.zotero,
      account,
      () => deps.zotero.collections(library, account.apiKey),
      now,
    )
    const collection = collections.find((entry) => entry.key === input.collectionKey)
    if (!collection) throw new ZoteroLibraryNotFoundException()
    collectionName = collection.name
    collectionScope = collectionSubtree(collections, collection.key)
  }

  const { link, created } = await db.transaction(async (trx) => {
    const { project: locked } = await projectFor(user, project.id, 'edit', { trx, lock: true })
    const existing = await ZoteroLink.query({ client: trx })
      .where('projectId', locked.id)
      .forUpdate()
      .first()
    const target = await resolveTarget(
      trx,
      locked.id,
      locked.ownerId,
      user,
      input.target,
      existing?.documentId ?? null,
    )
    const saved = existing ?? new ZoteroLink()
    saved.useTransaction(trx)
    const sameLibrary =
      existing !== null &&
      existing.libraryType === library.type &&
      existing.libraryId === library.id
    const sameSource = sameLibrary && existing.collectionKey === input.collectionKey
    // Pause en cours (lien précédent, ou compte : appels qui précèdent) : gardée.
    const pauses = [existing?.backoffUntil ?? null, account.backoffUntil].filter(
      (until): until is DateTime => until !== null && until > now,
    )
    saved.merge({
      projectId: locked.id,
      ownerId: user.id,
      zoteroUserId: account.zoteroUserId,
      libraryType: library.type,
      libraryId: library.id,
      libraryName,
      collectionKey: input.collectionKey,
      collectionName,
      collectionScope,
      documentId: target.document.id,
      exportFormat: input.exportFormat,
      apiKey: account.apiKey,
      // Même source : les éléments ajoutés par le sélecteur restent ; même bibliothèque : les
      // clés de citation attribuées aussi (les `\cite{…}` du projet restent valides).
      pickedItemKeys: sameSource ? existing.pickedItemKeys : [],
      citationKeys: sameLibrary ? existing.citationKeys : {},
      syncStatus: 'idle',
      lastLibraryVersion: null,
      lastError: null,
      backoffUntil: pauses.reduce<DateTime | null>(
        (latest, until) => (latest === null || until > latest ? until : latest),
        null,
      ),
      // Une synchro en cours de l'ancien lien n'écrira rien (réservation perdue).
      syncStartedAt: null,
    })
    await saved.save()
    if (target.created) await touchProject(trx, locked.id)
    return { link: saved, created: target.created ? target.document : null }
  })
  logger.info(
    {
      userId: user.id,
      projectId: project.id,
      libraryType: library.type,
      libraryId: library.id,
      collectionKey: input.collectionKey,
    },
    'zotero library linked',
  )
  if (created) {
    await deps.realtime.publishProjectEvent(project.id, {
      type: 'tree.changed',
      reason: 'create',
      actorId: user.id,
      changes: [
        {
          action: 'created',
          entity: 'document',
          id: created.id,
          parentId: created.folderId,
          name: created.name,
        },
      ],
    })
  }
  if (link.backoffUntil === null || link.backoffUntil <= now) {
    try {
      const synced = await syncProjectZotero(deps, user, project.id, 'manual', now)
      if (synced.link) return synced.link
    } catch (error) {
      logger.warn({ err: error, projectId: project.id }, 'first zotero sync failed')
    }
  } else {
    logger.info({ projectId: project.id }, 'first zotero sync postponed by zotero backoff')
  }
  await link.refresh()
  return (await announce(deps.realtime, project.id, user.id, link)) ?? serializeZoteroLink(link)
}

/** Retire le lien (le `.bib` reste dans le projet). Idempotent. */
export async function unlinkProjectFromZotero(
  deps: ZoteroDependencies,
  user: User,
  projectId: string,
): Promise<void> {
  const { project } = await projectFor(user, projectId, 'edit')
  const deleted = await ZoteroLink.query().where('projectId', project.id).delete()
  if (Number(deleted[0] ?? 0) === 0) return
  logger.info({ userId: user.id, projectId: project.id }, 'zotero library unlinked')
  await announce(deps.realtime, project.id, user.id, null)
}

/** Réserve la synchro du lien (une à la fois) ; faux si une autre tourne. */
async function claimSync(link: ZoteroLink, now: DateTime): Promise<boolean> {
  const result = await db.rawQuery<{ rows: { id: string }[] }>(
    `UPDATE zotero_links
        SET sync_status = 'syncing', sync_started_at = ?, updated_at = ?
      WHERE id = ?
        AND (sync_status <> 'syncing' OR sync_started_at IS NULL OR sync_started_at < ?)
      RETURNING id`,
    [
      now.toJSDate(),
      now.toJSDate(),
      link.id,
      now.minus({ minutes: zoteroConfig.staleSyncMinutes }).toJSDate(),
    ],
  )
  return result.rows.length > 0
}

/**
 * Lien verrouillé (`FOR UPDATE`) s'il porte toujours la réservation de cette synchro ; null s'il
 * a été supprimé, refait ou repris par une autre synchro entre-temps.
 */
async function lockClaimedLink(
  trx: TransactionClientContract,
  linkId: string,
  claimedAt: DateTime,
): Promise<ZoteroLink | null> {
  return ZoteroLink.query({ client: trx })
    .where('id', linkId)
    .where('syncStatus', 'syncing')
    .where('syncStartedAt', claimedAt.toJSDate())
    .forUpdate()
    .first()
}

/** Octets de l'état Yjs enregistré du document (estimation basse de son texte). */
async function storedBytes(documentId: string): Promise<number> {
  const row = (await db
    .from('documents')
    .where('id', documentId)
    .select(db.raw('COALESCE(octet_length(yjs_state), 0) AS bytes'))
    .first()) as { bytes: string | number } | null
  return Number(row?.bytes ?? 0)
}

/**
 * Synchronise le `.bib` du projet. `open` (ouverture du projet) ne lève pas d'erreur pour un
 * projet non lié, une tentative récente, une clé révoquée, une pause de Zotero ou une synchro en
 * cours : `skipped`. Une erreur de Zotero est enregistrée sur le lien puis levée. Un lien refait
 * ou supprimé pendant la synchro : rien n'est écrit, `skipped`.
 */
export async function syncProjectZotero(
  deps: ZoteroDependencies,
  user: User,
  projectId: string,
  trigger: ZoteroSyncTrigger,
  now: DateTime = DateTime.utc(),
): Promise<ZoteroSyncResponse> {
  const { project } = await projectFor(user, projectId, 'edit')
  const auto = trigger === 'open'
  const link = await ZoteroLink.findBy('projectId', project.id)
  if (!link) {
    if (auto) return { outcome: 'skipped', link: null }
    throw new ZoteroNotLinkedException()
  }
  const skip = async (): Promise<ZoteroSyncResponse> => ({
    outcome: 'skipped',
    link: await serializeZoteroLink(link),
  })
  if (
    auto &&
    link.syncStartedAt !== null &&
    now.diff(link.syncStartedAt).as('minutes') < zoteroConfig.autoSyncMinutes
  ) {
    return skip()
  }
  try {
    await usableLink(deps, project.id, now)
  } catch (error) {
    if (auto) return skip()
    throw error
  }
  if (!(await claimSync(link, now))) {
    if (auto) return skip()
    throw new ZoteroSyncInProgressException()
  }
  await link.refresh()
  const apiKey = link.apiKey ?? ''
  const library = libraryOf(link)
  let backoffSeconds: number | null = null
  try {
    if (link.documentId === null) throw new ZoteroInvalidTargetException()
    // Appels à Zotero, hors de tout verrou.
    const exported = await deps.zotero.exportLibrary(library, apiKey, {
      collectionKey: link.collectionKey,
      format: link.exportFormat,
      sinceVersion: auto ? link.lastLibraryVersion : null,
      maxItems: ZOTERO_MAX_EXPORTED_ITEMS,
      maxCollections: ZOTERO_MAX_SUBCOLLECTIONS,
    })
    backoffSeconds = exported.backoffSeconds
    const exportedValue = exported.value
    const entries: ItemEntry[] | null =
      exportedValue.status === 'exported' ? [...exportedValue.entries] : null
    const fetched = new Set(entries?.map((entry) => entry.itemKey) ?? [])

    let written: SyncWrite = { kind: 'retry' }
    for (let pass = 0; pass < MAX_SYNC_PASSES && written.kind === 'retry'; pass++) {
      if (entries !== null) {
        // Éléments ajoutés hors collection par le sélecteur (avant ou pendant la synchro) :
        // exportés hors verrou.
        const fresh = await ZoteroLink.find(link.id)
        const picked = (fresh?.collectionKey === null ? [] : (fresh?.pickedItemKeys ?? [])).filter(
          (key) => !fetched.has(key),
        )
        if (picked.length > 0) {
          const items = await deps.zotero.exportItems(library, apiKey, picked, link.exportFormat)
          backoffSeconds = items.backoffSeconds ?? backoffSeconds
          entries.push(...items.value)
          for (const key of picked) fetched.add(key)
        }
      }
      // Écriture sous le verrou du lien, si la réservation tient toujours et qu'aucun élément
      // choisi entre-temps ne manque (sinon une nouvelle passe l'exporte, hors verrou).
      written = await db.transaction(async (trx): Promise<SyncWrite> => {
        const current = await lockClaimedLink(trx, link.id, now)
        if (!current) return { kind: 'superseded' }
        let outcome: 'updated' | 'unchanged' = 'unchanged'
        let citationKeys = current.citationKeys
        if (entries !== null) {
          const late =
            current.collectionKey === null
              ? []
              : current.pickedItemKeys.filter((key) => !fetched.has(key))
          if (late.length > 0) return { kind: 'retry' }
          const document =
            current.documentId === null
              ? null
              : await Document.query({ client: trx })
                  .where({ id: current.documentId, projectId: project.id })
                  .first()
          if (!document) throw new ZoteroInvalidTargetException()
          const reserved = await otherBibKeys(project.id, document.id, null, trx)
          const built = managedBibliography(entries, current.citationKeys, reserved)
          if (built.renamed > 0) {
            logger.info(
              { projectId: project.id, linkId: link.id, renamed: built.renamed },
              'zotero citation keys disambiguated',
            )
          }
          const bytes = Buffer.byteLength(built.content, 'utf8')
          if (bytes >= MAX_TEXT_DOCUMENT_BYTES) throw new ZoteroBibTooLargeException()
          // Stockage du propriétaire du projet : ce que le texte ajoute à l'état enregistré.
          const growth = bytes - (await storedBytes(document.id))
          if (growth > 0) {
            await assertStorageAvailable(project.ownerId, growth, { requester: user })
          }
          // Service temps réel interne, délai borné : un ajout de citation attend ici au plus
          // ce délai (ses appels à Zotero et au service temps réel se font hors verrou).
          const replaced = await deps.realtime.replaceDocument(project.id, document.id, {
            content: built.content,
            userId: user.id,
          })
          if (!replaced) throw new ZoteroRealtimeUnavailableException()
          if (replaced.changed) outcome = 'updated'
          citationKeys = built.citationKeys
        }
        current.useTransaction(trx)
        current.merge({
          syncStatus: 'idle',
          lastSyncedAt: now,
          lastLibraryVersion: exportedValue.version ?? current.lastLibraryVersion,
          lastError: null,
          citationKeys,
          collectionScope:
            exportedValue.status === 'exported'
              ? exportedValue.collectionScope
              : current.collectionScope,
          backoffUntil:
            backoffSeconds !== null && backoffSeconds > 0
              ? now.plus({ seconds: backoffSeconds })
              : null,
        })
        await current.save()
        return { kind: 'written', outcome, current }
      })
    }
    // Éléments choisis sans arrêt pendant la synchro : elle s'arrête sans rien écrire.
    if (written.kind === 'retry') throw new ZoteroSyncInProgressException()
    if (written.kind === 'superseded') {
      logger.info(
        { projectId: project.id, linkId: link.id, trigger },
        'zotero synchronization superseded by a new link',
      )
      const current = await ZoteroLink.findBy('projectId', project.id)
      return {
        outcome: 'skipped',
        link: current === null ? null : await serializeZoteroLink(current),
      }
    }
    if (backoffSeconds !== null && backoffSeconds > 0) {
      const account = await ownerAccountQuery(link).first()
      if (account) await rememberAccountBackoff(account.id, backoffSeconds, now)
    }
    logger.info(
      {
        projectId: project.id,
        linkId: link.id,
        outcome: written.outcome,
        trigger,
        version: written.current.lastLibraryVersion,
      },
      'zotero library synchronized',
    )
    return {
      outcome: written.outcome,
      link: await announce(deps.realtime, project.id, user.id, written.current),
    }
  } catch (error) {
    const failure = await explainedZoteroFailure(deps.zotero, apiKey, error)
    const retryAfter =
      failure instanceof ZoteroBackoffException ? failure.retryAfterSeconds : backoffSeconds
    const paused = retryAfter !== null && retryAfter > 0
    // Seulement si la réservation tient toujours : un nouveau lien n'hérite pas de l'erreur.
    const updated = await ZoteroLink.query()
      .where('id', link.id)
      .where('syncStartedAt', now.toJSDate())
      .update({
        syncStatus: 'error',
        lastError: errorCodeOf(failure),
        backoffUntil: paused ? now.plus({ seconds: retryAfter }).toJSDate() : null,
      })
    if (paused) {
      const account = await ownerAccountQuery(link).first()
      if (account) await rememberAccountBackoff(account.id, retryAfter, now)
    }
    logger.warn(
      { projectId: project.id, linkId: link.id, trigger, code: errorCodeOf(failure) },
      'zotero synchronization failed',
    )
    if (Number(updated[0] ?? 0) > 0) {
      await link.refresh()
      await announce(deps.realtime, project.id, user.id, link)
    }
    throw failure
  }
}

/** Issue de l'écriture d'une synchro sous le verrou du lien. */
type SyncWrite =
  | { kind: 'written'; outcome: 'updated' | 'unchanged'; current: ZoteroLink }
  /** Lien refait ou supprimé pendant la synchro : rien n'est écrit. */
  | { kind: 'superseded' }
  /** Éléments choisis pendant la synchro, pas encore exportés : nouvelle passe. */
  | { kind: 'retry' }

/**
 * Clés de citation prises par d'autres éléments : celles du texte, celles attribuées et celles
 * des autres `.bib` du projet (`reserved`).
 */
function takenKeys(
  text: string,
  citationKeys: Record<string, string>,
  itemKey: string,
  reserved: ReadonlySet<string>,
) {
  const taken = bibKeys(text)
  for (const key of reserved) taken.add(key)
  for (const [other, key] of Object.entries(citationKeys)) {
    if (other !== itemKey) taken.add(key)
  }
  return taken
}

/**
 * Recherche dans la bibliothèque liée (titre, auteurs, année). Lien à une collection : un autre
 * éditeur que celui qui a lié ne voit que les éléments de la collection et de ses
 * sous-collections, et ceux déjà ajoutés au `.bib` (filtrés parmi les `SCOPED_SEARCH_LIMIT`
 * premiers résultats de Zotero). La clé proposée est celle de l'élément dans le `.bib`, ou celle
 * qu'un ajout lui donnerait.
 */
export async function searchProjectZotero(
  deps: ZoteroDependencies,
  user: User,
  projectId: string,
  query: string,
  now: DateTime = DateTime.utc(),
): Promise<ZoteroSearchItem[]> {
  const { project } = await projectFor(user, projectId, 'edit')
  const link = await usableLink(deps, project.id, now)
  const scope = scopeFor(link, user)
  const hits = await withLinkKey(deps, link, now, () =>
    deps.zotero.search(libraryOf(link), link.apiKey, query, {
      limit: scope === null ? ZOTERO_SEARCH_LIMIT : SCOPED_SEARCH_LIMIT,
      format: link.exportFormat,
    }),
  )
  const visible = (
    scope === null
      ? hits
      : hits.filter(
          (hit) =>
            link.pickedItemKeys.includes(hit.key) || hit.collections.some((key) => scope.has(key)),
        )
  ).slice(0, ZOTERO_SEARCH_LIMIT)
  const document =
    link.documentId === null
      ? null
      : await Document.query().where({ id: link.documentId, projectId: project.id }).first()
  const text = readDocumentText(document?.yjsState ? new Uint8Array(document.yjsState) : null)
  const present = bibKeys(text)
  const reserved =
    document === null ? new Set<string>() : await otherBibKeys(project.id, document.id, null)
  return visible.map((hit) => {
    const known = link.citationKeys[hit.key]
    const inBibliography = known !== undefined && present.has(known)
    const base = firstBibEntry(hit.exported)?.key ?? null
    const citationKey = inBibliography
      ? known
      : base === null
        ? null
        : assignCitationKey(base, known, takenKeys(text, link.citationKeys, hit.key, reserved))
    return {
      itemKey: hit.key,
      citationKey,
      itemType: hit.itemType,
      title: hit.title,
      creators: shortCreators(hit.creators),
      year: yearOf(hit.date),
      inBibliography,
    }
  })
}

/**
 * Ajoute au `.bib` lié l'entrée d'un élément de la bibliothèque s'il n'y est pas. Sous le verrou
 * du lien (aucun appel externe) : contrôle de la collection (lien à une collection : hors de
 * celle-ci, seul le membre qui a lié peut ajouter un élément), du plafond des éléments ajoutés
 * hors collection (422 `E_ZOTERO_PICKED_LIMIT`, plutôt qu'une entrée que la synchro suivante
 * supprimerait), clé de citation unique (dans ce `.bib` et les autres `.bib` du projet) retenue
 * avec l'élément. Puis, verrou relâché, entrée ajoutée à la fin du texte courant par le service
 * temps réel (insertion seule, idempotente : aucune frappe concurrente n'est écrasée). Sans
 * réponse du service, l'ajout a pu se faire ou non (503) : le refaire est sans risque.
 */
export async function addZoteroCitation(
  deps: ZoteroDependencies,
  user: User,
  projectId: string,
  itemKey: string,
  now: DateTime = DateTime.utc(),
): Promise<AddZoteroCitationResponse> {
  const { project } = await projectFor(user, projectId, 'edit')
  const link = await usableLink(deps, project.id, now)
  const documentId = link.documentId
  if (documentId === null) throw new ZoteroInvalidTargetException()
  const exported = await withLinkKey(deps, link, now, () =>
    deps.zotero.exportItems(libraryOf(link), link.apiKey, [itemKey], link.exportFormat),
  )
  const entry = exported.find((candidate) => candidate.itemKey === itemKey)
  const parsed = entry ? firstBibEntry(entry.text) : null
  if (!entry || !parsed) throw new ZoteroItemNotFoundException()
  // Texte courant de tous les documents (hors verrou) : le `.bib` lié et les autres `.bib`.
  const snapshot = await deps.realtime.snapshot(project.id)
  const live = snapshot?.documents.find((candidate) => candidate.id === documentId)
  if (!snapshot || !live) throw new ZoteroRealtimeUnavailableException()
  const liveTexts = new Map(snapshot.documents.map((document) => [document.id, document.content]))

  const decided = await db.transaction(async (trx) => {
    const current = await ZoteroLink.query({ client: trx }).where('id', link.id).forUpdate().first()
    if (!current) throw new ZoteroNotLinkedException()
    // Lien refait entre-temps vers une autre bibliothèque : l'élément n'en fait pas partie.
    if (current.libraryType !== link.libraryType || current.libraryId !== link.libraryId) {
      throw new ZoteroItemNotFoundException()
    }
    if (current.documentId !== documentId) throw new ZoteroInvalidTargetException()
    const known = current.citationKeys[itemKey]
    if (known !== undefined && bibKeys(live.content).has(known)) {
      return { citationKey: known, block: null }
    }
    const scope = scopeOf(current)
    const inCollection = scope === null || entry.collections.some((key) => scope.has(key))
    const alreadyPicked = current.pickedItemKeys.includes(itemKey)
    if (!inCollection && !alreadyPicked && current.ownerId !== user.id) {
      throw new ZoteroItemNotFoundException()
    }
    // Hors de la collection liée : retenu pour que les synchros suivantes le gardent.
    const pick = !inCollection && !alreadyPicked
    if (pick && current.pickedItemKeys.length >= ZOTERO_MAX_PICKED_ITEMS) {
      throw new ZoteroPickedLimitException()
    }
    const reserved = await otherBibKeys(project.id, documentId, liveTexts, trx)
    const citationKey = assignCitationKey(
      parsed.key,
      known,
      takenKeys(live.content, current.citationKeys, itemKey, reserved),
    )
    const block =
      citationKey === parsed.key ? parsed.text : withCitationKey(parsed.text, citationKey)
    const bytes = Buffer.byteLength(appendBibEntry(live.content, block), 'utf8')
    if (bytes >= MAX_TEXT_DOCUMENT_BYTES) throw new ZoteroBibTooLargeException()
    await assertStorageAvailable(
      project.ownerId,
      Math.max(0, bytes - Buffer.byteLength(live.content, 'utf8')),
      { requester: user },
    )
    current.useTransaction(trx)
    current.merge({
      citationKeys: { ...current.citationKeys, [itemKey]: citationKey },
      pickedItemKeys: pick ? [...current.pickedItemKeys, itemKey] : current.pickedItemKeys,
    })
    await current.save()
    return { citationKey, block }
  })
  if (decided.block === null) return { citationKey: decided.citationKey, added: false }

  const appended = await deps.realtime.replaceDocument(project.id, documentId, {
    content: decided.block,
    userId: user.id,
    append: true,
  })
  // Sans réponse, l'entrée a pu être ajoutée ou non : clé et élément restent retenus (la
  // synchro suivante écrit l'élément choisi ; un nouvel essai ne l'ajoute pas deux fois).
  if (!appended) throw new ZoteroRealtimeUnavailableException()
  logger.info(
    {
      projectId: project.id,
      userId: user.id,
      itemKey,
      citationKey: decided.citationKey,
      renamed: decided.citationKey !== parsed.key,
      added: appended.changed,
    },
    'zotero citation added',
  )
  return { citationKey: decided.citationKey, added: appended.changed }
}
