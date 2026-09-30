import env from '#start/env'

/** Service temps réel (apps/realtime) : jetons de connexion et routes internes. */
const realtimeConfig = {
  tokenSecret: env.get('REALTIME_TOKEN_SECRET'),
  internalToken: env.get('INTERNAL_TOKEN'),
  publicUrl: env.get('REALTIME_PUBLIC_URL'),
  internalUrl: env.get('REALTIME_INTERNAL_URL'),
  /** Au-delà, un appel interne est abandonné : la suppression d'un document ne doit pas bloquer. */
  internalTimeoutMs: 2_000,
}

export default realtimeConfig
