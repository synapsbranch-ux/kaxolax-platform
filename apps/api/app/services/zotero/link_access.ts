import { hasPermission, ZOTERO_ERRORS } from '@kaxolax/contracts'
import logger from '@adonisjs/core/services/logger'
import db from '@adonisjs/lucid/services/db'
import type { TransactionClientContract } from '@adonisjs/lucid/types/database'
import type { ProjectRole } from '#models/project_member'
import ZoteroLink from '#models/zotero_link'
import { PROJECT_ACCESS_VIEW } from '#services/project_access'

/**
 * Droit d'usage de la clé Zotero recopiée sur le lien d'un projet : elle n'est utilisable que
 * tant que le membre qui a lié garde la permission `edit` sur le projet. Retiré, parti ou passé
 * relecteur ou lecteur, sa clé est effacée du lien (`E_ZOTERO_KEY_INVALID`) : les autres
 * éditeurs ne peuvent plus lire sa bibliothèque, un éditeur doit refaire le lien avec la sienne.
 * Le droit est le rôle effectif (vue `project_access_roles`) : invitation ou équipe. Appelé par
 * le partage et la synchronisation des équipes (même transaction), revérifié à chaque usage.
 */

/** Le compte a encore la permission `edit` sur le projet (rôle effectif, équipe comprise). */
export async function memberCanEdit(
  projectId: string,
  userId: string,
  trx?: TransactionClientContract,
): Promise<boolean> {
  const member = (await (trx ?? db)
    .from(PROJECT_ACCESS_VIEW)
    .where({ project_id: projectId, user_id: userId })
    .select('role')
    .first()) as { role: ProjectRole } | null
  return member !== null && hasPermission(member.role, 'edit')
}

/**
 * Efface la clé du lien du projet créé par ce compte (il vient de perdre `edit`). Renvoie vrai
 * si un lien a perdu sa clé.
 */
export async function dropZoteroKeyOf(
  projectId: string,
  userId: string,
  trx?: TransactionClientContract,
): Promise<boolean> {
  const updated = await ZoteroLink.query({ client: trx })
    .where({ projectId, ownerId: userId })
    .whereNotNull('api_key_encrypted')
    .update({ apiKey: null, lastError: ZOTERO_ERRORS.keyInvalid })
  const dropped = Number(updated[0] ?? 0) > 0
  if (dropped) logger.info({ projectId, userId }, 'zotero key dropped from project link')
  return dropped
}

/** Efface la clé du lien de ce compte s'il n'a plus `edit` sur le projet (rôle effectif). */
export async function dropZoteroKeyUnlessEditor(
  projectId: string,
  userId: string,
  trx?: TransactionClientContract,
): Promise<boolean> {
  if (await memberCanEdit(projectId, userId, trx)) return false
  return dropZoteroKeyOf(projectId, userId, trx)
}

/**
 * Accès d'équipe changés (départ, rôle, équipe dissoute, projet transféré) : efface la clé des
 * liens de ces comptes sur ces projets là où ils n'ont plus `edit`. Renvoie le nombre de clés
 * effacées.
 */
export async function dropZoteroKeysWithoutEdit(
  projectIds: string[],
  userIds: string[],
  trx: TransactionClientContract,
): Promise<number> {
  if (projectIds.length === 0 || userIds.length === 0) return 0
  const links = (await trx
    .from('zotero_links')
    .whereIn('project_id', projectIds)
    .whereIn('owner_id', userIds)
    .whereNotNull('api_key_encrypted')
    .select('project_id', 'owner_id')) as { project_id: string; owner_id: string }[]
  let dropped = 0
  for (const link of links) {
    if (await dropZoteroKeyUnlessEditor(link.project_id, link.owner_id, trx)) dropped += 1
  }
  return dropped
}
