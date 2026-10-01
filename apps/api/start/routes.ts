/*
|--------------------------------------------------------------------------
| Routes de l'API REST (préfixe /api/v1)
|--------------------------------------------------------------------------
*/
import router from '@adonisjs/core/services/router'
import { middleware } from '#start/kernel'
import { emailThrottle, loginIpThrottle, loginThrottle, registerThrottle } from '#start/limiter'

const AuthController = () => import('#controllers/auth_controller')
const MeController = () => import('#controllers/me_controller')
const ClerkWebhooksController = () => import('#controllers/clerk_webhooks_controller')
const ProjectsController = () => import('#controllers/projects_controller')
const TreeController = () => import('#controllers/tree_controller')
const RealtimeController = () => import('#controllers/realtime_controller')
const UploadsController = () => import('#controllers/uploads_controller')
const ImportsController = () => import('#controllers/imports_controller')
const FilesController = () => import('#controllers/files_controller')
const CompilesController = () => import('#controllers/compiles_controller')
const ExportsController = () => import('#controllers/exports_controller')

router
  .group(() => {
    router.get('health', () => ({ status: 'ok' }))

    // Signé par Clerk (Standard Webhooks) : ni session ni jeton.
    router.post('webhooks/clerk', [ClerkWebhooksController, 'handle'])
    // Lien chiffré de 60 s, lié à l'utilisateur et au projet (navigation sans en-tête Authorization).
    router.get('downloads/:token', [ExportsController, 'downloadWithLink'])

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
        router.get('me', [MeController, 'show'])

        router.get('projects', [ProjectsController, 'index'])
        router.post('projects', [ProjectsController, 'store'])
        router.get('projects/:id', [ProjectsController, 'show'])
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

        router.post('projects/:id/compile', [CompilesController, 'compile'])
        router.post('projects/:id/compile/stop', [CompilesController, 'stop'])
        router.get('projects/:id/compile/last', [CompilesController, 'last'])
        router.post('projects/:id/compile/clear-cache', [CompilesController, 'clearCache'])
        router.get('projects/:id/synctex/code', [CompilesController, 'synctexCode'])
        router.get('projects/:id/synctex/pdf', [CompilesController, 'synctexPdf'])
        router.get('projects/:id/download.zip', [ExportsController, 'download'])
        router.post('projects/:id/download-url', [ExportsController, 'downloadUrl'])
      })
      .use(middleware.auth())
  })
  .prefix('/api/v1')
