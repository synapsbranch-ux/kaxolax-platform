import { isSafeRelativePath } from '@kaxolax/contracts'
import vine from '@vinejs/vine'

const relativePathRule = vine.createRule((value, _options, field) => {
  if (typeof value !== 'string' || !isSafeRelativePath(value)) {
    field.report('The {{ field }} field is not a valid path in the project', 'relativePath', field)
  }
})

/** Du code vers le PDF : fichier (chemin dans le projet), ligne et colonne. */
export const synctexCodeValidator = vine.create({
  file: vine.string().use(relativePathRule()),
  line: vine.number().withoutDecimals().min(1),
  column: vine.number().withoutDecimals().min(0).optional(),
})

/** Du PDF vers le code : page et position en points PDF (origine en haut à gauche). */
export const synctexPdfValidator = vine.create({
  page: vine.number().withoutDecimals().min(1),
  h: vine.number(),
  v: vine.number(),
})
