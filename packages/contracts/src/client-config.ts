import { z } from 'zod'

/**
 * GET /api/v1/client-config (public) : origines vues par le navigateur, tirées de la
 * configuration de l'API. Le serveur Next.js de apps/web s'en sert pour compléter sa CSP quand
 * ses propres variables (`REALTIME_PUBLIC_URL`, `S3_PUBLIC_ENDPOINT`, `TEMPLATES_*`) manquent :
 * une seule source de vérité, et aucun service web qui s'arrête faute de les avoir reçues.
 * Rien de secret : ces URL sont déjà données au navigateur (jetons temps réel, URL présignées,
 * miniatures des templates).
 */
export const clientConfigSchema = z.object({
  /** URL WebSocket du service temps réel (`REALTIME_PUBLIC_URL` de l'API). */
  realtimeUrl: z.string().regex(/^wss?:\/\//),
  /** Point d'accès des URL présignées du stockage ; null si l'API ne peut pas le déterminer. */
  storageUrl: z.url({ protocol: /^https?$/ }).nullable(),
  /** Catalogue et fichiers publics des templates (vide sans catalogue configuré). */
  templateUrls: z.array(z.url({ protocol: /^https?$/ })),
})
export type ClientConfig = z.infer<typeof clientConfigSchema>
