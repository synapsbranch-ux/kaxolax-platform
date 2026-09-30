import { fileURLToPath } from 'node:url'
import type { NextConfig } from 'next'
import { serverEnv } from './src/env'

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Image Docker autonome pour le staging.
  output: 'standalone',
  // Monorepo : le suivi des fichiers du serveur autonome part de la racine du dépôt.
  outputFileTracingRoot: fileURLToPath(new URL('../../', import.meta.url)),
  poweredByHeader: false,
  // Même origine pour le navigateur : en local, /api va vers l'API AdonisJS. En staging, le proxy
  // de l'instance (Caddy, derrière CloudFront) route /api/* vers l'API avant Next.js.
  rewrites() {
    return Promise.resolve([
      { source: '/api/:path*', destination: `${serverEnv.API_INTERNAL_URL}/api/:path*` },
    ])
  },
}

export default nextConfig
