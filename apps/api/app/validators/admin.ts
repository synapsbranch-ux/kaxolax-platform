import {
  ADMIN_AUDIT_ACTIONS,
  ADMIN_AUDIT_TARGET_TYPES,
  ADMIN_MAX_PAGE_SIZE,
  ADMIN_PROJECT_VIEWS,
  BANNER_LEVELS,
  BANNER_MESSAGE_MAX_LENGTH,
} from '@kaxolax/contracts'
import vine from '@vinejs/vine'
import { DateTime } from 'luxon'
import { singleLineRule } from '#validators/rules'

/**
 * Date et heure ISO 8601 avec fuseau (`Z` ou `+02:00`), comme `z.iso.datetime({ offset: true })`
 * dans les contrats : une heure sans fuseau serait ambiguë.
 */
const ISO_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})$/

const isoDateTimeRule = vine.createRule((value, _options, field) => {
  if (typeof value !== 'string') return
  if (!ISO_DATE_TIME.test(value) || !DateTime.fromISO(value).isValid) {
    field.report(
      'The {{ field }} field must be an ISO 8601 date with a time zone',
      'isoDate',
      field,
    )
  }
})

/** Date ISO avec fuseau, convertie en DateTime UTC. */
const isoDateTime = () =>
  vine
    .string()
    .trim()
    .use(isoDateTimeRule())
    .transform((value) => DateTime.fromISO(value, { zone: 'utc' }))

const pagination = () => ({
  page: vine.number().withoutDecimals().min(1).optional(),
  perPage: vine.number().withoutDecimals().min(1).max(ADMIN_MAX_PAGE_SIZE).optional(),
})

const search = () => vine.string().trim().maxLength(255).optional()

export const adminUsersQueryValidator = vine.create({ q: search(), ...pagination() })

export const adminProjectsQueryValidator = vine.create({
  q: search(),
  view: vine.enum(ADMIN_PROJECT_VIEWS).optional(),
  ...pagination(),
})

export const adminPageQueryValidator = vine.create({ ...pagination() })

export const transferProjectValidator = vine.create({ newOwnerId: vine.string().uuid() })

const bannerMessage = () =>
  vine.string().trim().minLength(1).maxLength(BANNER_MESSAGE_MAX_LENGTH).use(singleLineRule())

export const createBannerValidator = vine.create({
  message: bannerMessage(),
  level: vine.enum(BANNER_LEVELS),
  startsAt: isoDateTime().optional(),
  endsAt: isoDateTime().nullable().optional(),
})

export const updateBannerValidator = vine.create({
  message: bannerMessage().optional(),
  level: vine.enum(BANNER_LEVELS).optional(),
  startsAt: isoDateTime().optional(),
  endsAt: isoDateTime().nullable().optional(),
})

export const adminStatsQueryValidator = vine.create({
  from: isoDateTime().optional(),
  to: isoDateTime().optional(),
})

export const auditLogQueryValidator = vine.create({
  adminId: vine.string().uuid().optional(),
  action: vine.enum(ADMIN_AUDIT_ACTIONS).optional(),
  targetType: vine.enum(ADMIN_AUDIT_TARGET_TYPES).optional(),
  targetId: vine.string().trim().maxLength(255).optional(),
  outcome: vine.enum(['success', 'failure'] as const).optional(),
  from: isoDateTime().optional(),
  to: isoDateTime().optional(),
  ...pagination(),
})
