/**
 * Canal temps réel de l'utilisateur (`user:{id}`) : délais avant de le rouvrir après un échec
 * (jeton non obtenu, refus, fermeture par le serveur), doublés à chaque échec consécutif. Les
 * coupures réseau sont reprises par le WebSocket lui-même ; le sondage des bannières reste le
 * filet pendant ce temps.
 */
export const USER_CHANNEL_RETRY_MIN_MS = 5_000
export const USER_CHANNEL_RETRY_MAX_MS = 60_000

/** Délai avant la prochaine ouverture, après `failures` échecs consécutifs (0 : premier échec). */
export function userChannelRetryDelay(failures: number): number {
  const exponent = Math.max(0, Math.min(failures, 10))
  return Math.min(USER_CHANNEL_RETRY_MAX_MS, USER_CHANNEL_RETRY_MIN_MS * 2 ** exponent)
}
