import { MAX_IMPORT_ZIP_BYTES, MAX_UPLOAD_BYTES } from '@kaxolax/contracts'
import vine from '@vinejs/vine'
import { entityNameRule, singleLineRule } from '#validators/rules'

/** Le navigateur annonce la taille exacte : elle est signée dans l'URL d'upload. */
export const createUploadValidator = vine.create({
  filename: vine.string().use(entityNameRule()),
  folderId: vine.string().uuid().nullable().optional(),
  sizeBytes: vine.number().withoutDecimals().min(0).max(MAX_UPLOAD_BYTES),
})

export const createImportValidator = vine.create({
  filename: vine
    .string()
    .maxLength(255)
    .use(singleLineRule())
    .regex(/\.zip$/i),
  sizeBytes: vine.number().withoutDecimals().min(1).max(MAX_IMPORT_ZIP_BYTES),
  /** Workspace du futur projet (vérifié avant l'upload) ; absent : workspace personnel. */
  workspaceId: vine.string().uuid().optional(),
})

export const completeImportValidator = vine.create({
  /** Absent : workspace personnel de l'utilisateur. */
  workspaceId: vine.string().uuid().optional(),
})

export const fileUrlValidator = vine.create({
  /** Téléchargement (attachment) plutôt qu'affichage dans le navigateur (inline). */
  download: vine.boolean().optional(),
})
