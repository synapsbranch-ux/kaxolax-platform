import {
  type PlanLimitError,
  planLimitErrorSchema,
  storageStateMessageSchema,
} from '@kaxolax/contracts'

/**
 * Refus `E_PLAN_LIMIT` de l'API (403) : message en français, limite et lien vers les tarifs. Les
 * limites sont appliquées par l'API ; l'interface ne fait que les expliquer.
 */

/** Corps `E_PLAN_LIMIT` d'une erreur de l'API (`ApiError.body`), sinon null. */
export function planLimitOf(body: unknown): PlanLimitError | null {
  const parsed = planLimitErrorSchema.safeParse(body)
  return parsed.success ? parsed.data : null
}

/** Taille lisible en octets binaires, à la française (« 500 Mo », « 1,5 Go »). */
export function formatBytes(bytes: number): string {
  const units = ['octets', 'Ko', 'Mo', 'Go', 'To']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  const rounded = unit === 0 ? value : Math.round(value * 10) / 10
  return `${rounded.toLocaleString('fr-FR')} ${units[unit] ?? 'octets'}`
}

/** Durée lisible (« 20 s », « 4 min »). */
export function formatSeconds(seconds: number): string {
  if (seconds < 60 || seconds % 60 !== 0) return `${seconds.toLocaleString('fr-FR')} s`
  return `${(seconds / 60).toLocaleString('fr-FR')} min`
}

/** Libellé d'un plan Clerk (slug) pour l'interface. */
export function planLabel(slug: string): string {
  if (slug === 'free') return 'Free'
  if (slug === 'pro') return 'Pro'
  return slug
}

/** Titre et explication d'un refus, selon la limite atteinte. */
export function planLimitMessage(error: PlanLimitError): { title: string; description: string } {
  const plan = planLabel(error.limit.plan)
  const { max } = error.limit
  switch (error.limit.name) {
    case 'compile_time':
      return {
        title: 'Durée de compilation dépassée',
        description: `Le plan ${plan} du propriétaire du projet limite chaque compilation à ${formatSeconds(max)}. Un plan supérieur permet des compilations plus longues.`,
      }
    case 'collaborators':
      return {
        title: 'Limite de collaborateurs atteinte',
        description: `Le plan ${plan} du propriétaire du projet permet ${String(max)} collaborateur${max > 1 ? 's' : ''} (invitations en attente comprises). Un plan supérieur permet d'inviter sans limite.`,
      }
    case 'storage':
      return {
        title: 'Espace de stockage plein',
        description: `Le plan ${plan} du propriétaire du projet offre ${formatBytes(max)}${error.current === undefined ? '' : ` (utilisés : ${formatBytes(error.current)})`}. Libérez de la place ou passez à un plan supérieur.`,
      }
    case 'history':
      return {
        title: 'Historique limité',
        description: `Le plan ${plan} conserve l'historique ${String(max)} jour${max > 1 ? 's' : ''}. Un plan supérieur conserve l'historique complet.`,
      }
  }
}

type PlanLimitListener = (error: PlanLimitError, handled: () => boolean) => void
const listeners = new Set<PlanLimitListener>()
const handled = new WeakSet<object>()

/**
 * Écoute les refus `E_PLAN_LIMIT` reçus par le client de l'API (boîte de dialogue globale). Le
 * second argument dit si l'appelant les affiche déjà lui-même (`markPlanLimitHandled`).
 */
export function onPlanLimit(listener: PlanLimitListener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** Annonce un refus reçu par l'API ; `source` : l'erreur levée vers l'appelant. */
export function reportPlanLimit(error: PlanLimitError, source: object): void {
  for (const listener of listeners) listener(error, () => handled.has(source))
}

/**
 * À appeler dans le `catch` d'un appel dont l'écran affiche lui-même le refus (`PlanLimitNotice`
 * en ligne, par exemple dans la modale de partage) : la boîte de dialogue globale ne s'ouvre pas.
 */
export function markPlanLimitHandled(error: unknown): void {
  if (typeof error === 'object' && error !== null) handled.add(error)
}

/** Origine de la page (navigateur), ou une origine locale hors navigateur (tests). */
function pageOrigin(): string {
  return typeof window === 'undefined' ? 'http://localhost' : window.location.origin
}

/**
 * Message sans état du service temps réel (`onStateless` d'un document) : un stockage du
 * propriétaire devenu plein (éditions refusées, document en lecture seule) est annoncé comme un
 * refus `E_PLAN_LIMIT` de limite `storage`. Les autres messages sont ignorés. Renvoie le refus
 * annoncé, sinon null.
 */
export function reportRealtimePlanLimit(payload: string): PlanLimitError | null {
  let data: unknown
  try {
    data = JSON.parse(payload)
  } catch {
    return null
  }
  const message = storageStateMessageSchema.safeParse(data)
  if (!message.success || !message.data.full) return null
  const error: PlanLimitError = {
    code: 'E_PLAN_LIMIT',
    message: 'The storage limit of the project owner plan is reached',
    limit: { name: 'storage', plan: message.data.plan, max: message.data.max },
    feature: 'extra_storage',
    ...(message.data.current === undefined ? {} : { current: message.data.current }),
    upgradeUrl: new URL('/pricing', pageOrigin()).href,
  }
  reportPlanLimit(error, {})
  return error
}

/**
 * Message `plan.storage` qui rend l'écriture (stockage libéré) : le client se resynchronise pour
 * que les éditions refusées entre-temps soient renvoyées et ne restent pas « en cours d'envoi ».
 */
export function isStorageAvailableMessage(payload: string): boolean {
  try {
    const message = storageStateMessageSchema.safeParse(JSON.parse(payload))
    return message.success && !message.data.full
  } catch {
    return false
  }
}
