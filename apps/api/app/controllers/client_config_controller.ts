import type { HttpContext } from '@adonisjs/core/http'
import type { ClientConfig } from '@kaxolax/contracts'
import realtimeConfig from '#config/realtime'
import storageConfig from '#config/storage'
import templatesConfig from '#config/templates'

/**
 * Origine des URL présignées, comme les signe `object_storage.ts` : point d'accès public, sinon
 * celui du serveur ; sans aucun des deux (AWS S3 avec le rôle de l'instance), point d'accès
 * régional d'AWS (URL en `bucket.s3.<région>.amazonaws.com`, couvertes par ses sous-domaines).
 */
export function storageOrigin(settings: {
  publicEndpoint?: string | undefined
  endpoint?: string | undefined
  region: string
}): string | null {
  const endpoint = settings.publicEndpoint ?? settings.endpoint
  if (endpoint !== undefined && endpoint !== '') return endpoint
  return /^[a-z]{2}(-[a-z]+)+-\d+$/.test(settings.region)
    ? `https://s3.${settings.region}.amazonaws.com`
    : null
}

export default class ClientConfigController {
  /** Origines vues par le navigateur, lues par le serveur Next.js pour sa CSP (public). */
  show({ response }: HttpContext): ClientConfig {
    // Lu par le serveur web à intervalles : une nouvelle configuration de l'API s'y propage.
    response.header('cache-control', 'no-store')
    return {
      realtimeUrl: realtimeConfig.publicUrl,
      storageUrl: storageOrigin(storageConfig),
      templateUrls: [templatesConfig.catalogUrl, templatesConfig.publicUrl].filter(
        (url): url is string => url !== null,
      ),
    }
  }
}
