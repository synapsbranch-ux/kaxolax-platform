import { type DateTime } from 'luxon'

/** Date ISO 8601 en UTC ; une date invalide est une erreur de programmation. */
export function isoString(value: DateTime): string {
  const iso = value.toUTC().toISO()
  if (iso === null) throw new Error(`Invalid date: ${value.invalidReason ?? 'unknown reason'}`)
  return iso
}

/** Idem, null pour une date absente. */
export function isoStringOrNull(value: DateTime | null | undefined): string | null {
  return value ? isoString(value) : null
}
