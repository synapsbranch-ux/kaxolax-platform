import { ADMIN_DEFAULT_PAGE_SIZE } from '@kaxolax/contracts'
import { inject } from '@adonisjs/core'
import type { HttpContext } from '@adonisjs/core/http'
import {
  type AdminUserDependencies,
  banUser,
  deleteUser,
  findUserOrFail,
  revokeUserSessions,
  searchUsers,
  unbanUser,
  userDetail,
  userSummary,
} from '#services/admin_users'
import ClerkBackend from '#services/clerk_backend'
import ObjectStorage, { CompileOutputStorage } from '#services/object_storage'
import RealtimeClient from '#services/realtime_client'
import ZoteroClient from '#services/zotero/client'
import { adminUsersQueryValidator } from '#validators/admin'

/** Admin : comptes (recherche, fiche, bannissement, sessions, suppression via Clerk). */
@inject()
export default class AdminUsersController {
  private readonly deps: AdminUserDependencies

  constructor(
    clerk: ClerkBackend,
    realtime: RealtimeClient,
    storage: ObjectStorage,
    outputs: CompileOutputStorage,
    zotero: ZoteroClient,
  ) {
    this.deps = { clerk, realtime, storage, outputs, zotero }
  }

  async index({ request }: HttpContext) {
    const { q, page, perPage } = await request.validateUsing(adminUsersQueryValidator, {
      data: request.qs(),
    })
    return searchUsers({ q, page: page ?? 1, perPage: perPage ?? ADMIN_DEFAULT_PAGE_SIZE })
  }

  async show({ params }: HttpContext) {
    const user = await findUserOrFail(String(params.id))
    return { user: await userDetail(user, this.deps.clerk) }
  }

  async ban({ params, auth }: HttpContext) {
    const target = await findUserOrFail(String(params.id))
    const { user, realtimeDisconnected } = await banUser(auth.getUserOrFail(), target, this.deps)
    return { user: await userSummary(user), realtimeDisconnected }
  }

  async unban({ params, auth }: HttpContext) {
    const target = await findUserOrFail(String(params.id))
    const user = await unbanUser(auth.getUserOrFail(), target, this.deps)
    return { user: await userSummary(user) }
  }

  async revokeSessions({ params, auth }: HttpContext) {
    const target = await findUserOrFail(String(params.id))
    return revokeUserSessions(auth.getUserOrFail(), target, this.deps)
  }

  async destroy({ params, auth }: HttpContext) {
    const target = await findUserOrFail(String(params.id))
    const { user, realtimeDisconnected } = await deleteUser(auth.getUserOrFail(), target, this.deps)
    return { user: await userSummary(user), realtimeDisconnected }
  }
}
