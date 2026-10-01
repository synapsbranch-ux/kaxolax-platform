import env from '#start/env'

/** Une clé PEM tient sur une ligne dans un fichier d'environnement : les « \n » sont restaurés. */
function pem(value: string | undefined): string | undefined {
  const key = value?.replaceAll('\\n', '\n').trim()
  return key === '' ? undefined : key
}

const clerkConfig = {
  jwtKey: pem(env.get('CLERK_JWT_KEY')),
  secretKey: env.get('CLERK_SECRET_KEY'),
  webhookSigningSecret: env.get('CLERK_WEBHOOK_SIGNING_SECRET'),
  /** Origines autorisées à émettre un jeton (claim `azp`) : l'application et l'admin. */
  authorizedParties: [env.get('APP_URL'), env.get('ADMIN_URL')]
    .filter((url) => url !== undefined)
    .map((url) => new URL(url).origin),
  /** Durée de cache de l'état Clerk d'un admin (rôle, MFA activée), lu par l'API Backend. */
  adminStatusCacheMs: 60_000,
}

export default clerkConfig
