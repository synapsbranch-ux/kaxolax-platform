/*
|--------------------------------------------------------------------------
| Routes de l'API REST (préfixe /api/v1)
|--------------------------------------------------------------------------
*/
import router from '@adonisjs/core/services/router'
import { middleware } from '#start/kernel'
import { emailThrottle, loginIpThrottle, loginThrottle, registerThrottle } from '#start/limiter'

const AuthController = () => import('#controllers/auth_controller')
const ProjectsController = () => import('#controllers/projects_controller')
const TreeController = () => import('#controllers/tree_controller')
const RealtimeController = () => import('#controllers/realtime_controller')
const UploadsController = () => import('#controllers/uploads_controller')
const ImportsController = () => import('#controllers/imports_controller')
const FilesController = () => import('#controllers/files_controller')

router
  .group(() => {
    router.get('health', () => ({ status: 'ok' }))

    router
      .group(() => {
        router.post('register', [AuthController, 'register']).use(registerThrottle)
        router.post('login', [AuthController, 'login']).use([loginIpThrottle, loginThrottle])
        router.post('logout', [AuthController, 'logout']).use(middleware.auth())
        router.get('me', [AuthController, 'me']).use(middleware.auth())
        router.post('verify-email', [AuthController, 'verifyEmail'])
        router
          .post('resend-verification', [AuthController, 'resendVerification'])
          .use(emailThrottle)
        router.post('forgot-password', [AuthController, 'forgotPassword']).use(emailThrottle)
        router.post('reset-password', [AuthController, 'resetPassword'])
      })
      .prefix('auth')

    router
      .group(() => {
        router.get('projects', [ProjectsController, 'index'])
        router.post('projects', [ProjectsController, 'store'])
        router.patch('projects/:id', [ProjectsController, 'update'])
        router.post('projects/:id/archive', [ProjectsController, 'archive'])
        router.post('projects/:id/unarchive', [ProjectsController, 'unarchive'])
        router.post('projects/:id/trash', [ProjectsController, 'trash'])
        router.post('projects/:id/restore', [ProjectsController, 'restore'])
        router.delete('projects/:id', [ProjectsController, 'destroy'])

        router.get('projects/:id/tree', [TreeController, 'show'])
        router.post('projects/:id/folders', [TreeController, 'storeFolder'])
        router.post('projects/:id/documents', [TreeController, 'storeDocument'])
        router.patch('projects/:id/entities/:type/:entityId', [TreeController, 'update'])
        router.delete('projects/:id/entities/:type/:entityId', [TreeController, 'destroy'])
        router.get('projects/:id/files/:fileId/url', [FilesController, 'url'])

        router.post('projects/:id/uploads', [UploadsController, 'store'])
        router.post('projects/:id/uploads/:uploadId/complete', [UploadsController, 'complete'])
        router.post('imports', [ImportsController, 'store'])
        router.post('imports/:uploadId/complete', [ImportsController, 'complete'])

        router.post('projects/:id/realtime-token', [RealtimeController, 'token'])
      })
      .use(middleware.auth())
  })
  .prefix('/api/v1')
