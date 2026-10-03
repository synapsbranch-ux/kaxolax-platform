import { hasPermission, ZOTERO_ERRORS } from '@kaxolax/contracts'
import logger from '@adonisjs/core/services/logger'
import db from '@adonisjs/lucid/services/db'
import type { TransactionClientContract } from '@adonisjs/lucid/types/database'
import type { ProjectRole } from '#models/project_member'
import ZoteroLink from '#models/zotero_link'

/**
 * Droit d'usage de la clé Zotero recopiée sur le lien d'un projet : elle n'est utilisable que
 * tant que le membre qui a lié garde la permission `edit` sur le projet. Retiré, parti ou passé
 * relecteur ou lecteur, sa clé est effacée du lien (`E_ZOTERO_KEY_INVALID`) : les autres
 * éditeurs ne peuvent plus lire sa bibliothèque, un éditeur doit refaire le lien avec la sienne.
 * Appelé par le partage (même transaction) et revérifié à chaque usage (filet).
 */

/** Le compte a encore la permission `edit` sur le projet. */
export async function memberCanEdit(
  projectId: string,
  userId: string,
  trx?: TransactionClientContract,
): Promise<boolean> {
  const member = (await (trx ?? db)
    .from('project_members')
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
