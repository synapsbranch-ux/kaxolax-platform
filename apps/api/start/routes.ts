/*
|--------------------------------------------------------------------------
| Routes de l'API REST (préfixe /api/v1)
|--------------------------------------------------------------------------
*/
import router from '@adonisjs/core/services/router'
import { registerAdminRoutes } from '#start/admin_routes'
import { middleware } from '#start/kernel'

const MeController = () => import('#controllers/me_controller')
const PlanController = () => import('#controllers/plan_controller')
const PreferencesController = () => import('#controllers/preferences_controller')
const ClerkWebhooksController = () => import('#controllers/clerk_webhooks_controller')
const WorkspacesController = () => import('#controllers/workspaces_controller')
const ProjectsController = () => import('#controllers/projects_controller')
const TreeController = () => import('#controllers/tree_controller')
const RealtimeController = () => import('#controllers/realtime_controller')
const UploadsController = () => import('#controllers/uploads_controller')
const ImportsController = () => import('#controllers/imports_controller')
const FilesController = () => import('#controllers/files_controller')
const CompilesController = () => import('#controllers/compiles_controller')
const ExportsController = () => import('#controllers/exports_controller')
const BuildsController = () => import('#controllers/builds_controller')
const CompileCallbacksController = () => import('#controllers/compile_callbacks_controller')
const SearchController = () => import('#controllers/search_controller')
const BannersController = () => import('#controllers/banners_controller')
const SharingController = () => import('#controllers/sharing_controller')
const JoinController = () => import('#controllers/join_controller')
const ChatController = () => import('#controllers/chat_controller')
const CommentsController = () => import('#controllers/comments_controller')
const HistoryController = () => import('#controllers/history_controller')
const TexliveController = () => import('#controllers/texlive_controller')
const WordCountsController = () => import('#controllers/word_counts_controller')
const TemplatesController = () => import('#controllers/templates_controller')

router
  .group(() => {
    router.get('health', () => ({ status: 'ok' }))

    // Signé par Clerk (Standard Webhooks) : ni session ni jeton.
    router.post('webhooks/clerk', [ClerkWebhooksController, 'handle'])
    // Lien chiffré de 60 s, lié à l'utilisateur et au projet (navigation sans en-tête Authorization).
    router.get('downloads/:token', [ExportsController, 'downloadWithLink'])
    router.get('version-downloads/:token', [HistoryController, 'downloadWithLink'])
    // Rappels du Worker de compilation Cloudflare : corps signé (HMAC), ni session ni jeton.
    router.post('internal/compile-callbacks', [CompileCallbacksController, 'handle'])
    // Aperçus publics d'une invitation et d'un lien de partage (nom du projet, rôle).
    router.get('invitations/:token', [JoinController, 'invitation'])
    router.get('share/:token', [JoinController, 'shareLink'])
    // Galerie de templates publique (catalogue kaxolax-templates, packages/contracts templates.ts).
    router.get('templates', [TemplatesController, 'index'])
    router.get('templates/:id', [TemplatesController, 'show'])

    router
      .group(() => {
        router.get('me', [MeController, 'show'])
        // Plan, features, limites et usage (Clerk Billing ; affichage, limites appliquées par route).
        router.get('me/plan', [PlanController, 'show'])
        router.get('me/preferences', [PreferencesController, 'show'])
        router.patch('me/preferences', [PreferencesController, 'update'])
        // Bannières système actives (affichées en haut de l'application).
        router.get('banners/active', [BannersController, 'active'])

        router.get('workspaces', [WorkspacesController, 'index'])

        // Index des packages TeX Live (packages/contracts/src/texlive.ts).
        router.get('texlive/packages', [TexliveController, 'index'])
        router.get('texlive/packages/:name', [TexliveController, 'show'])
        router.get('texlive/suggestions', [TexliveController, 'suggestions'])

        router.get('projects', [ProjectsController, 'index'])
        router.post('projects', [ProjectsController, 'store'])
        router.post('projects/from-template', [TemplatesController, 'store'])
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
        router.get('projects/:id/search', [SearchController, 'search'])

        router.post('projects/:id/uploads', [UploadsController, 'store'])
        router.post('projects/:id/uploads/:uploadId/complete', [UploadsController, 'complete'])
        router.post('imports', [ImportsController, 'store'])
        router.post('imports/:uploadId/complete', [ImportsController, 'complete'])

        router.post('projects/:id/realtime-token', [RealtimeController, 'token'])

        // Partage (packages/contracts/src/sharing.ts).
        router.get('projects/:id/members', [SharingController, 'members'])
        router.patch('projects/:id/members/:userId', [SharingController, 'updateMember'])
        router.delete('projects/:id/members/:userId', [SharingController, 'removeMember'])
        router.post('projects/:id/transfer', [SharingController, 'transfer'])
        router.get('projects/:id/invitations', [SharingController, 'invitations'])
        router.post('projects/:id/invitations', [SharingController, 'invite'])
        router.post('projects/:id/invitations/:invitationId/resend', [SharingController, 'resend'])
        router.delete('projects/:id/invitations/:invitationId', [SharingController, 'cancel'])
        router.get('projects/:id/share-links', [SharingController, 'shareLinks'])
        router.put('projects/:id/share-links/:kind', [SharingController, 'updateShareLink'])
        router.post('projects/:id/share-links/:kind/regenerate', [
          SharingController,
          'regenerateShareLink',
        ])
        router.post('invitations/:token/accept', [JoinController, 'acceptInvitation'])
        router.post('share/:token/join', [JoinController, 'joinWithShareLink'])

        // Chat du projet (packages/contracts/src/chat.ts) : tout membre.
        router.get('projects/:id/chat/messages', [ChatController, 'index'])
        router.post('projects/:id/chat/messages', [ChatController, 'store'])
        router.post('projects/:id/chat/read', [ChatController, 'read'])

        // Commentaires ancrés et panneau Review (packages/contracts/src/comments.ts) : lecture par
        // tout membre, écriture avec la permission `comment`, modification par l'auteur.
        router.get('projects/:id/comment-threads', [CommentsController, 'index'])
        router.post('projects/:id/comment-threads', [CommentsController, 'store'])
        router.get('projects/:id/comment-threads/:threadId', [CommentsController, 'show'])
        router.post('projects/:id/comment-threads/:threadId/comments', [
          CommentsController,
          'reply',
        ])
        router.patch('projects/:id/comment-threads/:threadId/comments/:commentId', [
          CommentsController,
          'update',
        ])
        router.delete('projects/:id/comment-threads/:threadId/comments/:commentId', [
          CommentsController,
          'destroy',
        ])
        router.post('projects/:id/comment-threads/:threadId/resolve', [
          CommentsController,
          'resolve',
        ])
        router.post('projects/:id/comment-threads/:threadId/reopen', [CommentsController, 'reopen'])

        // Historique (packages/contracts/src/history.ts) : lecture par tout membre, label et
        // restauration avec la permission `edit`.
        router.get('projects/:id/versions', [HistoryController, 'index'])
        router.get('projects/:id/versions/:versionId', [HistoryController, 'show'])
        router.patch('projects/:id/versions/:versionId', [HistoryController, 'update'])
        router.get('projects/:id/versions/:versionId/documents/:documentId/diff', [
          HistoryController,
          'diff',
        ])
        router.get('projects/:id/versions/:versionId/files/:fileId/url', [
          HistoryController,
          'fileUrl',
        ])
        router.post('projects/:id/versions/:versionId/restore', [HistoryController, 'restore'])
        router.get('projects/:id/versions/:versionId/download.zip', [HistoryController, 'download'])
        router.post('projects/:id/versions/:versionId/download-url', [
          HistoryController,
          'downloadUrl',
        ])

        router.post('projects/:id/compile', [CompilesController, 'compile'])
        router.post('projects/:id/compile/stop', [CompilesController, 'stop'])
        router.get('projects/:id/compile/last', [CompilesController, 'last'])
        router.post('projects/:id/compile/clear-cache', [CompilesController, 'clearCache'])
        router.get('projects/:id/synctex/code', [CompilesController, 'synctexCode'])
        router.get('projects/:id/synctex/pdf', [CompilesController, 'synctexPdf'])
        router.get('projects/:id/builds/:buildId', [BuildsController, 'show'])
        router.post('projects/:id/compiler/warm', [BuildsController, 'warm'])
        router.post('projects/:id/word-count', [WordCountsController, 'count'])
        router.get('projects/:id/download.zip', [ExportsController, 'download'])
        router.post('projects/:id/download-url', [ExportsController, 'downloadUrl'])
      })
      .use(middleware.auth())

    registerAdminRoutes()
  })
  .prefix('/api/v1')
