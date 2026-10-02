import { ADMIN_ROLE } from '@kaxolax/contracts'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Accès à l'admin d'après les claims de la session Clerk : rôle `admin` (claim `metadata.role`,
 * soit `publicMetadata.role`) et second facteur vérifié pendant la session (claim `fva` :
 * `[minutes depuis le 1er facteur, minutes depuis le 2e facteur ou -1]`). Premier filtre
 * seulement : l'API revérifie à chaque appel, MFA activée comprise (API Backend de Clerk).
 */
export function hasAdminAccess(claims: unknown): boolean {
  if (!isRecord(claims)) return false
  const { metadata, fva } = claims
  if (!isRecord(metadata) || metadata.role !== ADMIN_ROLE) return false
  if (!Array.isArray(fva) || fva.length !== 2) return false
  const secondFactorAge: unknown = fva[1]
  return (
    typeof secondFactorAge === 'number' && Number.isInteger(secondFactorAge) && secondFactorAge >= 0
  )
}
