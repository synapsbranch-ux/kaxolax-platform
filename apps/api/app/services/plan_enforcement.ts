import {
  type CompileResult,
  MAX_COMPILE_TIMEOUT_MS,
  MIN_COMPILE_TIMEOUT_MS,
  type PlanLimitError,
} from '@kaxolax/contracts'
import db from '@adonisjs/lucid/services/db'
import type { TransactionClientContract } from '@adonisjs/lucid/types/database'
import { PlanLimitException, planLimitBody } from '#exceptions/plan_limit'
import type User from '#models/user'
import { has, limitsOf } from '#services/entitlements'

/**
 * Limites du plan appliquées par l'API. Pour une action sur un projet, ce sont celles du
 * propriétaire du projet, même quand un collaborateur agit.
 */

/**
 * Stockage d'un compte : octets des fichiers binaires et des états Yjs des documents de tous les
 * projets dont il est propriétaire (archivés et corbeille compris).
 */
export async function storageUsage(
  ownerId: string,
  client?: TransactionClientContract,
): Promise<number> {
  const result = await (client ?? db).rawQuery<{ rows: { used: string | number | null }[] }>(
    `SELECT
       (SELECT COALESCE(SUM(f.size_bytes), 0) FROM files f
          JOIN projects p ON p.id = f.project_id WHERE p.owner_id = ?)
       + (SELECT COALESCE(SUM(octet_length(d.yjs_state)), 0) FROM documents d
          JOIN projects p ON p.id = d.project_id WHERE p.owner_id = ?) AS used`,
    [ownerId, ownerId],
  )
  // SUM d'un bigint : numeric, renvoyé en texte par pg.
  return Number(result.rows[0]?.used ?? 0)
}

/** Stockage d'un projet : octets de ses fichiers binaires et des états Yjs de ses documents. */
export async function projectStorageUsage(
  projectId: string,
  client?: TransactionClientContract,
): Promise<number> {
  const result = await (client ?? db).rawQuery<{ rows: { used: string | number | null }[] }>(
    `SELECT
       (SELECT COALESCE(SUM(f.size_bytes), 0) FROM files f WHERE f.project_id = ?)
       + (SELECT COALESCE(SUM(octet_length(d.yjs_state)), 0) FROM documents d
          WHERE d.project_id = ?) AS used`,
    [projectId, projectId],
  )
  return Number(result.rows[0]?.used ?? 0)
}

/**
 * Collaborateurs d'un projet : membres autres que le propriétaire, plus invitations en attente non
 * expirées ni annulées (une place est réservée dès l'invitation). `excludeInvitationId` :
 * invitation comptée à part (acceptée ou renvoyée).
 */
export async function projectCollaboratorCount(
  projectId: string,
  client?: TransactionClientContract,
  excludeInvitationId?: string,
): Promise<number> {
  const result = await (client ?? db).rawQuery<{ rows: { used: number }[] }>(
    `SELECT
       (SELECT COUNT(*)::int FROM project_members WHERE project_id = ? AND role <> 'owner')
       + (SELECT COUNT(*)::int FROM project_invitations
            WHERE project_id = ? AND accepted_at IS NULL AND cancelled_at IS NULL
              AND expires_at > now()
              AND id IS DISTINCT FROM ?::uuid) AS used`,
    [projectId, projectId, excludeInvitationId ?? null],
  )
  return result.rows[0]?.used ?? 0
}

/**
 * Refuse (403 `E_PLAN_LIMIT`, limite `storage`) d'ajouter `addedBytes` au stockage du compte
 * `ownerId` au-delà de son plan ; un stockage déjà plein refuse aussi un ajout vide (document
 * vide). L'usage (`current`) n'est joint au refus que si `requester` est le titulaire du compte.
 * Dans une transaction, un verrou consultatif par compte sérialise les ajouts simultanés
 * (aucun verrou de ligne : pas de conflit d'ordre avec ceux des projets). `applied` : les
 * `addedBytes` sont déjà écrits dans la transaction (restauration de l'historique, dont l'ajout
 * n'est connu qu'une fois l'arborescence remise) ; l'usage d'avant l'ajout en est déduit.
 */
export async function assertStorageAvailable(
  ownerId: string,
  addedBytes: number,
  options: { requester?: User | null; trx?: TransactionClientContract; applied?: boolean } = {},
): Promise<void> {
  const { requester, trx } = options
  if (trx) {
    await trx.rawQuery('SELECT pg_advisory_xact_lock(hashtext(?))', [`storage:${ownerId}`])
  }
  const limits = await limitsOf({ id: ownerId }, requester, trx)
  const used = (await storageUsage(ownerId, trx)) - (options.applied ? addedBytes : 0)
  if (used >= limits.storageBytes || used + addedBytes > limits.storageBytes) {
    throw new PlanLimitException({
      name: 'storage',
      plan: limits.entitlements.plan,
      max: limits.storageBytes,
      // Usage de tout le compte : réservé à son titulaire (un collaborateur ne voit que le refus).
      ...(requester?.id === ownerId ? { current: used } : {}),
    })
  }
}

/**
 * Durée maximale de compilation d'un projet (ms), envoyée dans chaque demande : celle du plan du
 * propriétaire (`requester` : compte qui compile, dont les claims servent s'il est le
 * propriétaire), bornée à la plage acceptée par le contrat.
 */
export async function compileTimeoutMs(ownerId: string, requester?: User | null): Promise<number> {
  return clampedCompileTimeoutMs((await limitsOf({ id: ownerId }, requester)).maxCompileSeconds)
}

/** Durée maximale (ms) d'un plan, bornée à la plage acceptée par le contrat. */
function clampedCompileTimeoutMs(maxCompileSeconds: number): number {
  return Math.min(
    MAX_COMPILE_TIMEOUT_MS,
    Math.max(MIN_COMPILE_TIMEOUT_MS, maxCompileSeconds * 1000),
  )
}

/**
 * Indication jointe à une compilation en délai dépassé : la limite du plan du propriétaire, si
 * un plan supérieur la lève (feature `long_compile` absente) et si le build a tourné sous cette
 * limite (durée enregistrée égale à celle du plan actuel) ; sinon rien.
 */
export async function compileTimeLimitNotice(
  compile: { projectId: string; status: string; timeoutMs: number | null },
  requester?: User | null,
): Promise<PlanLimitError | undefined> {
  if (compile.status !== 'timeout' || compile.timeoutMs === null) return undefined
  const project = (await db
    .from('projects')
    .where('id', compile.projectId)
    .select('owner_id')
    .first()) as { owner_id: string } | null
  if (!project) return undefined
  const limits = await limitsOf({ id: project.owner_id }, requester)
  if (has(limits.entitlements, { feature: 'long_compile' })) return undefined
  // Build lancé sous un autre plan (changement depuis) : sa durée n'est pas la limite actuelle.
  if (compile.timeoutMs !== clampedCompileTimeoutMs(limits.maxCompileSeconds)) return undefined
  return planLimitBody({
    name: 'compile_time',
    plan: limits.entitlements.plan,
    max: Math.round(compile.timeoutMs / 1000),
  })
}

/** Résultat de compilation complété par l'indication de limite du plan, s'il y a lieu. */
export async function withCompileTimeLimit(
  result: CompileResult,
  compile: { projectId: string; timeoutMs: number | null },
  requester?: User | null,
): Promise<CompileResult> {
  const planLimit = await compileTimeLimitNotice({ ...compile, status: result.status }, requester)
  return planLimit ? { ...result, planLimit } : result
}

/** Plus grand nombre de collaborateurs (membres hors propriétaire et invitations en attente). */
export async function maxCollaboratorsInOwnedProjects(ownerId: string): Promise<number> {
  const result = await db.rawQuery<{ rows: { used: number | null }[] }>(
    `SELECT MAX(
       (SELECT COUNT(*)::int FROM project_members m WHERE m.project_id = p.id AND m.role <> 'owner')
       + (SELECT COUNT(*)::int FROM project_invitations i
            WHERE i.project_id = p.id AND i.accepted_at IS NULL AND i.cancelled_at IS NULL
              AND i.expires_at > now())) AS used
     FROM projects p WHERE p.owner_id = ?`,
    [ownerId],
  )
  return result.rows[0]?.used ?? 0
}

/**
 * Transfert de propriété : le projet passe sous les limites du nouveau propriétaire. Refuse
 * (403 `E_PLAN_LIMIT`) si son stockage ne peut pas accueillir le projet (même règle que
 * `assertStorageAvailable`, verrou consultatif du compte compris), ou si les collaborateurs du
 * projet après le transfert (ancien propriétaire devenu éditeur compris, nouveau propriétaire
 * exclu) dépassent sa limite. À appeler dans la transaction du transfert, projet verrouillé,
 * membres déjà mis à jour. `requester` : compte qui agit (ses claims ne servent que s'il est le
 * nouveau propriétaire, jamais le cas ici).
 */
export async function assertTransferWithinLimits(
  projectId: string,
  newOwnerId: string,
  trx: TransactionClientContract,
  requester?: User | null,
): Promise<void> {
  await assertStorageAvailable(newOwnerId, await projectStorageUsage(projectId, trx), {
    requester,
    trx,
  })
  const limits = await limitsOf({ id: newOwnerId }, requester, trx)
  const collaborators = await projectCollaboratorCount(projectId, trx)
  if (limits.maxCollaborators !== null && collaborators > limits.maxCollaborators) {
    throw new PlanLimitException({
      name: 'collaborators',
      plan: limits.entitlements.plan,
      max: limits.maxCollaborators,
      current: collaborators,
    })
  }
}
