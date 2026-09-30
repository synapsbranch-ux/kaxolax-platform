import env from '#start/env'

/** Stockage S3 des fichiers de projet et des sorties de compilation. */
const storageConfig = {
  region: env.get('S3_REGION'),
  endpoint: env.get('S3_ENDPOINT'),
  publicEndpoint: env.get('S3_PUBLIC_ENDPOINT'),
  forcePathStyle: env.get('S3_FORCE_PATH_STYLE', false),
  accessKeyId: env.get('S3_ACCESS_KEY_ID'),
  secretAccessKey: env.get('S3_SECRET_ACCESS_KEY'),
  projectFilesBucket: env.get('S3_BUCKET_PROJECT_FILES'),
  compileOutputsBucket: env.get('S3_BUCKET_COMPILE_OUTPUTS'),
  /** Durée de validité d'une URL d'upload, puis du droit de compléter l'upload. */
  uploadUrlTtlSeconds: 15 * 60,
  uploadTtlSeconds: 60 * 60,
  /** Durée de validité d'une URL de lecture (aperçu, téléchargement). */
  downloadUrlTtlSeconds: 5 * 60,
}

export default storageConfig
