import type { NextConfig } from 'next'
import { serverEnv } from './src/env'

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Image Docker autonome pour le staging.
  output: 'standalone',
  poweredByHeader: false,
  // Même origine pour le navigateur : en local, /api va vers l'API AdonisJS. En staging, CloudFront
  // route /api/* vers l'API avant d'atteindre Next.js.
  rewrites() {
    return Promise.resolve([
      { source: '/api/:path*', destination: `${serverEnv.API_INTERNAL_URL}/api/:path*` },
    ])
  },
}

export default nextConfig
