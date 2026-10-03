import { type AdminStats, type CompileStatus, compileStatusSchema } from '@kaxolax/contracts'
import { formatNumber, formatRate } from './format'

const STATUS_LABELS: Record<CompileStatus, string> = {
  success: 'Réussies',
  failure: 'Erreurs LaTeX',
  timeout: 'Durée dépassée',
  error: 'Erreur du service',
}

/**
 * Lignes du graphique « Compilations par résultat » : une par statut terminé, part du total des
 * compilations terminées (les annulations, hors total, sont résumées par `cancelledSummary`).
 */
export function compileStatusRows(compiles: AdminStats['compiles']) {
  return compileStatusSchema.options.map((status) => {
    const value = compiles.byStatus[status]
    return {
      label: STATUS_LABELS[status],
      value,
      display: `${formatNumber(value)} · ${formatRate(compiles.total === 0 ? null : value / compiles.total)}`,
    }
  })
}

/** Compilations annulées de la période, comptées à part. */
export function cancelledSummary(compiles: AdminStats['compiles']): string {
  return `Annulées : ${formatNumber(compiles.cancelled)} (hors total, durée et taux d'échec ; les compilations en cours ne sont pas comptées).`
}
