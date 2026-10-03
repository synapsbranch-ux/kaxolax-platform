import { fileURLToPath } from 'node:url'
import type { NextConfig } from 'next'
import { serverEnv } from './src/env'
import { WEB_SECURITY_HEADERS } from './src/lib/security-headers'

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Serveur autonome pour l'image Docker (docker/Dockerfile, déployée sur Railway).
  output: 'standalone',
  // Monorepo : le suivi des fichiers du serveur autonome part de la racine du dépôt.
  outputFileTracingRoot: fileURLToPath(new URL('../../', import.meta.url)),
  poweredByHeader: false,
  // Dictionnaires du correcteur : lus avec leurs fichiers par Node au build (route statique
  // `app/dictionaries`), pas intégrés au bundle serveur.
  serverExternalPackages: ['dictionary-en', 'dictionary-fr'],
  // Même origine pour le navigateur : /api/* est relayé à l'API AdonisJS (API_INTERNAL_URL : local,
  // ou réseau privé de Railway en production). Cible figée par `next build` : valeur de build.
  rewrites() {
    return Promise.resolve([
      { source: '/api/:path*', destination: `${serverEnv.API_INTERNAL_URL}/api/:path*` },
    ])
  },
  // En-têtes de sécurité fixes de toutes les réponses ; la CSP (nonce par requête) est posée par
  // le proxy sur les pages (src/lib/security-headers.ts).
  headers() {
    return Promise.resolve([{ source: '/:path*', headers: [...WEB_SECURITY_HEADERS] }])
  },
}

export default nextConfig
