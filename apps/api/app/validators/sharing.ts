import { ASSIGNABLE_ROLES } from '@kaxolax/contracts'
import vine from '@vinejs/vine'

/** Mêmes règles que `createInvitationInputSchema` de `@kaxolax/contracts`. */
export const createInvitationValidator = vine.create({
  email: vine.string().trim().maxLength(254).email(),
  role: vine.enum(ASSIGNABLE_ROLES),
})

export const updateMemberRoleValidator = vine.create({ role: vine.enum(ASSIGNABLE_ROLES) })

export const transferOwnershipValidator = vine.create({ userId: vine.string().uuid() })

export const updateShareLinkValidator = vine.create({ enabled: vine.boolean({ strict: true }) })
