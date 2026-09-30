import { MAX_TEXT_DOCUMENT_BYTES } from '@kaxolax/contracts'
import vine from '@vinejs/vine'
import { entityNameRule, textDocumentNameRule } from '#validators/rules'

const entityName = () => vine.string().use(entityNameRule())

export const createFolderValidator = vine.create({
  name: entityName(),
  parentId: vine.string().uuid().nullable().optional(),
})

export const createDocumentValidator = vine.create({
  name: entityName().use(textDocumentNameRule()),
  folderId: vine.string().uuid().nullable().optional(),
  // Plafond en caractères ; la limite en octets est vérifiée par le contrôleur.
  content: vine.string().maxLength(MAX_TEXT_DOCUMENT_BYTES).optional(),
})

export const updateEntityValidator = vine.create({
  name: entityName().optional(),
  /** Dossier de destination ; null = racine du projet. */
  folderId: vine.string().uuid().nullable().optional(),
})

export const entityParamsValidator = vine.create({
  type: vine.enum(['folder', 'document', 'file'] as const),
})
