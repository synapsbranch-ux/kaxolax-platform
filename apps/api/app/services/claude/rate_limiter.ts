import { AI_RATE_LIMIT } from '@kaxolax/contracts'
import { AiRateLimitedException } from '#services/claude/errors'

/** Comptes suivis au plus : au-delà, les entrées inactives sont purgées. */
const MAX_TRACKED_USERS = 10_000

/**
 * Limite de débit des appels à Claude, par utilisateur et par instance de l'API (en mémoire,
 * comme les autres bornes de l'API) : `requests` appels sur une fenêtre glissante de
 * `windowSeconds`, `concurrent` en cours à la fois. Les crédits mensuels restent la vraie
 * limite de coût ; celle-ci arrête une boucle de requêtes.
 */
export class AiRateLimiter {
  private readonly calls = new Map<string, number[]>()
  private readonly running = new Map<string, number>()

  constructor(
    private readonly limit: {
      requests: number
      windowSeconds: number
      concurrent: number
    } = AI_RATE_LIMIT,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * Réserve une place pour un appel de `userId` ; lève `AiRateLimitedException` (429) sinon.
   * Renvoie la fonction qui libère la place d'appel en cours (à appeler une seule fois).
   */
  acquire(userId: string): () => void {
    const now = this.now()
    const windowMs = this.limit.windowSeconds * 1000
    const recent = (this.calls.get(userId) ?? []).filter((at) => at > now - windowMs)
    if (recent.length >= this.limit.requests) {
      const oldest = recent[0] ?? now
      throw new AiRateLimitedException(Math.max(1, Math.ceil((oldest + windowMs - now) / 1000)))
    }
    const running = this.running.get(userId) ?? 0
    if (running >= this.limit.concurrent) throw new AiRateLimitedException(1)
    if (this.calls.size >= MAX_TRACKED_USERS) this.purge(now - windowMs)
    recent.push(now)
    this.calls.set(userId, recent)
    this.running.set(userId, running + 1)
    let released = false
    return () => {
      if (released) return
      released = true
      const left = (this.running.get(userId) ?? 1) - 1
      if (left <= 0) this.running.delete(userId)
      else this.running.set(userId, left)
    }
  }

  /** Oublie les comptes sans appel récent ni en cours. */
  private purge(since: number): void {
    for (const [userId, times] of this.calls) {
      if (!this.running.has(userId) && times.every((at) => at <= since)) this.calls.delete(userId)
    }
  }

  /** Remet les compteurs à zéro (tests). */
  reset(): void {
    this.calls.clear()
    this.running.clear()
  }
}

/** Limite partagée par les appels de cette instance. */
export const aiRateLimiter = new AiRateLimiter()
