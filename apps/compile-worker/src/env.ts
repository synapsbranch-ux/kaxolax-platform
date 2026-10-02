import type { CompileContainer } from './container.js'

/** Bindings et variables du Worker (wrangler.jsonc ; secret : `wrangler secret put`). */
export interface Env {
  /** Durable Object + conteneur, une instance par projet (nom = projectId). */
  COMPILER: DurableObjectNamespace<CompileContainer>
  /** Bucket R2 des fichiers de projet (lecture des binaires). */
  PROJECT_FILES: R2Bucket
  /** Bucket R2 des sorties (demande écrite par l'API, PDF, log, SyncTeX). */
  COMPILE_OUTPUTS: R2Bucket
  /** Nom du bucket des sorties, tel que l'API l'écrit dans chaque demande. */
  OUTPUTS_BUCKET_NAME: string
  /** URL des rappels : https://api.<domaine>/api/v1/internal/compile-callbacks */
  API_CALLBACK_URL: string
  /** Secret partagé avec l'API (COMPILE_WORKER_SECRET), au moins 32 caractères. */
  COMPILE_WORKER_SECRET: string
}
