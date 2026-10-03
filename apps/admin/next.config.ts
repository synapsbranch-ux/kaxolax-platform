import { fileURLToPath } from 'node:url'
import type { NextConfig } from 'next'
import { serverEnv } from './src/env'
import { ADMIN_SECURITY_HEADERS } from './src/lib/security-headers'

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Image autonome (même principe que apps/web).
  output: 'standalone',
  // Monorepo : le suivi des fichiers du serveur autonome part de la racine du dépôt.
  outputFileTracingRoot: fileURLToPath(new URL('../../', import.meta.url)),
  poweredByHeader: false,
  // Même origine pour le navigateur : /api va vers l'API AdonisJS, qui revérifie tout.
  rewrites() {
    return Promise.resolve([
      { source: '/api/:path*', destination: `${serverEnv.API_INTERNAL_URL}/api/:path*` },
    ])
  },
  // L'admin n'est jamais indexée ni affichée dans un cadre ; la CSP (nonce par requête) est posée
  // par le proxy sur les pages (src/lib/security-headers.ts).
  headers() {
    return Promise.resolve([{ source: '/:path*', headers: [...ADMIN_SECURITY_HEADERS] }])
  },
}

export default nextConfig
