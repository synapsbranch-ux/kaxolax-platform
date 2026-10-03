/**
 * Exécuté une fois au démarrage du serveur Next.js (jamais pendant `next build`). Contrôles du
 * serveur Node.js seulement (`instrumentation-node.ts`).
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return
  const { checkStartupEnv } = await import('./instrumentation-node')
  checkStartupEnv()
}
