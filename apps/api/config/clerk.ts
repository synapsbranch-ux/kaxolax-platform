import env from '#start/env'

/** Une clé PEM tient sur une ligne dans un fichier d'environnement : les « \n » sont restaurés. */
function pem(value: string | undefined): string | undefined {
  const key = value?.replaceAll('\\n', '\n').trim()
  return key === '' ? undefined : key
}

const clerkConfig = {
  authMode: env.get('AUTH_MODE', 'dual'),
  jwtKey: pem(env.get('CLERK_JWT_KEY')),
  secretKey: env.get('CLERK_SECRET_KEY'),
  webhookSigningSecret: env.get('CLERK_WEBHOOK_SIGNING_SECRET'),
  /** Origines autorisées à émettre un jeton (claim `azp`) : l'application elle-même. */
  authorizedParties: [new URL(env.get('APP_URL')).origin],
}

export default clerkConfig
