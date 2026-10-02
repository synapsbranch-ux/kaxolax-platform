import type {
  ActiveBanner,
  AdminBanner,
  AdminPagination,
  BannerLevel,
  BannerStatus,
} from '@kaxolax/contracts'
import { Exception } from '@adonisjs/core/exceptions'
import db from '@adonisjs/lucid/services/db'
import type { TransactionClientContract } from '@adonisjs/lucid/types/database'
import { DateTime } from 'luxon'
import SystemBanner from '#models/system_banner'
import User from '#models/user'
import { type AdminAction, auditFailures, recordAdminAction } from '#services/admin_audit'
import { paginationOf } from '#services/admin_users'
import { isoString, isoStringOrNull } from '#services/dates'
import { isUuid } from '#services/project_access'
import type RealtimeClient from '#services/realtime_client'

export class BannerNotFoundException extends Exception {
  static override status = 404
  static override code = 'E_BANNER_NOT_FOUND'
  static override message = 'Banner not found'
}

export class InvalidBannerPeriodException extends Exception {
  static override status = 422
  static override code = 'E_INVALID_BANNER_PERIOD'
  static override message = 'A banner must end after it starts'
}

/** Champs saisis dans l'admin ; dates déjà converties en UTC. */
export interface BannerChanges {
  message?: string | undefined
  level?: BannerLevel | undefined
  startsAt?: DateTime | undefined
  /** Null : sans fin. */
  endsAt?: DateTime | null | undefined
}

/** Maintenance d'abord, puis avertissement, puis information ; les plus récentes d'abord. */
const LEVEL_ORDER_SQL = `CASE level WHEN 'maintenance' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END`

function serializeActive(banner: SystemBanner): ActiveBanner {
  return {
    id: banner.id,
    message: banner.message,
    level: banner.level,
    startsAt: isoString(banner.startsAt),
    endsAt: isoStringOrNull(banner.endsAt),
  }
}

function statusAt(banner: SystemBanner, now: DateTime): BannerStatus {
  if (banner.startsAt > now) return 'scheduled'
  if (banner.endsAt !== null && banner.endsAt <= now) return 'ended'
  return 'active'
}

/** Bannières affichées à l'instant : commencées et pas encore terminées. */
export async function activeBanners(now = DateTime.utc()): Promise<ActiveBanner[]> {
  const banners = await SystemBanner.query()
    .where('starts_at', '<=', now.toJSDate())
    .where((end) => {
      void end.whereNull('ends_at').orWhere('ends_at', '>', now.toJSDate())
    })
    .orderByRaw(`${LEVEL_ORDER_SQL}, starts_at DESC, id`)
  return banners.map(serializeActive)
}

async function serializeAdminBanners(
  banners: SystemBanner[],
  client?: TransactionClientContract,
): Promise<AdminBanner[]> {
  const creatorIds = [...new Set(banners.map((banner) => banner.createdBy))]
  const creators =
    creatorIds.length === 0
      ? []
      : await User.query({ client }).whereIn('id', creatorIds).select('id', 'email', 'full_name')
  const byId = new Map(creators.map((creator) => [creator.id, creator]))
  const now = DateTime.utc()
  return banners.map((banner) => {
    const creator = byId.get(banner.createdBy)
    return {
      ...serializeActive(banner),
      status: statusAt(banner, now),
      createdBy: {
        id: banner.createdBy,
        email: creator?.email ?? '',
        fullName: creator?.fullName ?? null,
      },
      createdAt: isoString(banner.createdAt),
    }
  })
}

/** Toutes les bannières, les plus récentes d'abord. */
export async function listBanners(
  page: number,
  perPage: number,
): Promise<{ banners: AdminBanner[]; pagination: AdminPagination }> {
  const result = await SystemBanner.query()
    .orderBy('created_at', 'desc')
    .orderBy('id')
    .paginate(page, perPage)
  return {
    banners: await serializeAdminBanners(result.all()),
    pagination: paginationOf(result),
  }
}

function assertPeriod(startsAt: DateTime, endsAt: DateTime | null): void {
  if (endsAt !== null && endsAt <= startsAt) throw new InvalidBannerPeriodException()
}

/** Prévient les navigateurs (aujourd'hui : sondage ; tâche 5 : diffusion en direct). */
async function notify(realtime: RealtimeClient): Promise<void> {
  await realtime.notifyBannerChanged(await activeBanners())
}

function bannerMetadata(banner: SystemBanner): Record<string, unknown> {
  return {
    message: banner.message,
    level: banner.level,
    startsAt: isoString(banner.startsAt),
    endsAt: isoStringOrNull(banner.endsAt),
  }
}

/** Crée une bannière (début par défaut : maintenant), journalisée dans la même transaction. */
export async function createBanner(
  admin: User,
  input: BannerChanges & { message: string; level: BannerLevel },
  realtime: RealtimeClient,
): Promise<AdminBanner> {
  const startsAt = input.startsAt ?? DateTime.utc()
  const endsAt = input.endsAt ?? null
  assertPeriod(startsAt, endsAt)
  const failure = {
    admin,
    action: 'banner.create' as const,
    targetType: 'banner' as const,
    targetId: null,
    metadata: { message: input.message, level: input.level },
  }
  const banner = await auditFailures(failure, () =>
    db.transaction(async (trx) => {
      const created = await SystemBanner.create(
        { message: input.message, level: input.level, startsAt, endsAt, createdBy: admin.id },
        { client: trx },
      )
      await recordAdminAction(
        {
          admin,
          action: 'banner.create',
          targetType: 'banner',
          targetId: created.id,
          metadata: bannerMetadata(created),
        },
        trx,
      )
      return created
    }),
  )
  await notify(realtime)
  const [serialized] = await serializeAdminBanners([await SystemBanner.findOrFail(banner.id)])
  if (!serialized) throw new BannerNotFoundException()
  return serialized
}

/** Entrée d'échec d'une action sur une bannière existante (journalisée par `auditFailures`). */
function bannerFailure(
  admin: User,
  action: 'banner.update' | 'banner.delete',
  bannerId: string,
): AdminAction {
  return { admin, action, targetType: 'banner', targetId: isUuid(bannerId) ? bannerId : null }
}

async function lockBanner(bannerId: string, trx: TransactionClientContract) {
  const banner = isUuid(bannerId)
    ? await SystemBanner.query({ client: trx }).where('id', bannerId).forUpdate().first()
    : null
  if (!banner) throw new BannerNotFoundException()
  return banner
}

/**
 * Applique un changement à une bannière verrouillée, vérifie la période (fin après début) et
 * journalise l'avant et l'après dans la même transaction. `apply` renvoie false si rien ne change :
 * rien n'est alors écrit ni diffusé.
 */
async function changeBanner(
  admin: User,
  bannerId: string,
  apply: (banner: SystemBanner) => boolean,
  realtime: RealtimeClient,
): Promise<AdminBanner> {
  const changed = await auditFailures(bannerFailure(admin, 'banner.update', bannerId), () =>
    db.transaction(async (trx) => {
      const locked = await lockBanner(bannerId, trx)
      const before = bannerMetadata(locked)
      if (!apply(locked)) return { banner: locked, changed: false }
      assertPeriod(locked.startsAt, locked.endsAt)
      await locked.useTransaction(trx).save()
      await recordAdminAction(
        {
          admin,
          action: 'banner.update',
          targetType: 'banner',
          targetId: locked.id,
          metadata: { before, after: bannerMetadata(locked) },
        },
        trx,
      )
      return { banner: locked, changed: true }
    }),
  )
  if (changed.changed) await notify(realtime)
  const [serialized] = await serializeAdminBanners([
    await SystemBanner.findOrFail(changed.banner.id),
  ])
  if (!serialized) throw new BannerNotFoundException()
  return serialized
}

/**
 * Modifie une bannière ; la période est vérifiée avec les valeurs enregistrées pour les champs non
 * fournis (fin après début).
 */
export async function updateBanner(
  admin: User,
  bannerId: string,
  changes: BannerChanges,
  realtime: RealtimeClient,
): Promise<AdminBanner> {
  return changeBanner(
    admin,
    bannerId,
    (banner) => {
      if (changes.message !== undefined) banner.message = changes.message
      if (changes.level !== undefined) banner.level = changes.level
      if (changes.startsAt !== undefined) banner.startsAt = changes.startsAt
      if (changes.endsAt !== undefined) banner.endsAt = changes.endsAt
      return true
    },
    realtime,
  )
}

/**
 * Termine une bannière à l'heure du serveur (pas celle du navigateur de l'admin). Une bannière
 * déjà terminée ne change pas ; une bannière pas encore commencée est refusée
 * (`E_INVALID_BANNER_PERIOD`) : la supprimer plutôt.
 */
export async function endBanner(
  admin: User,
  bannerId: string,
  realtime: RealtimeClient,
): Promise<AdminBanner> {
  return changeBanner(
    admin,
    bannerId,
    (banner) => {
      const now = DateTime.utc()
      if (banner.endsAt !== null && banner.endsAt <= now) return false
      banner.endsAt = now
      return true
    },
    realtime,
  )
}

/** Supprime une bannière (le journal garde son texte). */
export async function deleteBanner(
  admin: User,
  bannerId: string,
  realtime: RealtimeClient,
): Promise<void> {
  await auditFailures(bannerFailure(admin, 'banner.delete', bannerId), () =>
    db.transaction(async (trx) => {
      const banner = await lockBanner(bannerId, trx)
      const metadata = bannerMetadata(banner)
      await banner.useTransaction(trx).delete()
      await recordAdminAction(
        { admin, action: 'banner.delete', targetType: 'banner', targetId: bannerId, metadata },
        trx,
      )
    }),
  )
  await notify(realtime)
}
