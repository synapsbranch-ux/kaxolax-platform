/*
|--------------------------------------------------------------------------
| Routes de l'admin (/api/v1/admin) : compte authentifié, rôle admin et MFA
|--------------------------------------------------------------------------
*/
import router from '@adonisjs/core/services/router'
import { middleware } from '#start/kernel'

const AdminUsersController = () => import('#controllers/admin_users_controller')
const AdminProjectsController = () => import('#controllers/admin_projects_controller')
const AdminBannersController = () => import('#controllers/admin_banners_controller')
const AdminInsightsController = () => import('#controllers/admin_insights_controller')

/** Déclare les routes de l'admin ; appelée dans le groupe `/api/v1` de `start/routes.ts`. */
export function registerAdminRoutes() {
  router
    .group(() => {
      router.get('users', [AdminUsersController, 'index'])
      router.get('users/:id', [AdminUsersController, 'show'])
      router.post('users/:id/ban', [AdminUsersController, 'ban'])
      router.post('users/:id/unban', [AdminUsersController, 'unban'])
      router.post('users/:id/revoke-sessions', [AdminUsersController, 'revokeSessions'])
      router.delete('users/:id', [AdminUsersController, 'destroy'])

      router.get('projects', [AdminProjectsController, 'index'])
      router.get('projects/:id', [AdminProjectsController, 'show'])
      router.post('projects/:id/transfer', [AdminProjectsController, 'transfer'])
      router.post('projects/:id/archive', [AdminProjectsController, 'archive'])
      router.post('projects/:id/unarchive', [AdminProjectsController, 'unarchive'])
      router.post('projects/:id/trash', [AdminProjectsController, 'trash'])
      router.post('projects/:id/restore', [AdminProjectsController, 'restore'])
      router.delete('projects/:id', [AdminProjectsController, 'destroy'])

      router.get('banners', [AdminBannersController, 'index'])
      router.post('banners', [AdminBannersController, 'store'])
      router.patch('banners/:id', [AdminBannersController, 'update'])
      router.post('banners/:id/end', [AdminBannersController, 'end'])
      router.delete('banners/:id', [AdminBannersController, 'destroy'])

      router.get('stats', [AdminInsightsController, 'stats'])
      router.get('audit-log', [AdminInsightsController, 'auditLog'])
    })
    .prefix('admin')
    .use([middleware.auth(), middleware.admin()])
}
