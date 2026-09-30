import { hasTextDocumentExtension, isValidEntityName } from '@kaxolax/contracts'
import vine from '@vinejs/vine'

/** Nom de dossier, document ou fichier : mêmes règles que partout ailleurs (@kaxolax/contracts). */
export const entityNameRule = vine.createRule((value, _options, field) => {
  if (typeof value !== 'string' || !isValidEntityName(value)) {
    field.report('The {{ field }} field is not a valid name', 'entityName', field)
  }
})

/** Un document texte porte une extension texte (.tex, .bib, .sty…). */
export const textDocumentNameRule = vine.createRule((value, _options, field) => {
  if (typeof value === 'string' && !hasTextDocumentExtension(value)) {
    field.report(
      'A document must have a text extension such as .tex or .bib',
      'textExtension',
      field,
    )
  }
})

/** Texte libre sur une ligne (nom de projet, nom complet) : aucun caractère de contrôle. */
export const singleLineRule = vine.createRule((value, _options, field) => {
  // eslint-disable-next-line no-control-regex -- on cherche justement les caractères de contrôle
  if (typeof value === 'string' && /[\u0000-\u001f\u007f]/.test(value)) {
    field.report('The {{ field }} field contains invalid characters', 'singleLine', field)
  }
})

export const email = () => vine.string().trim().toLowerCase().email().maxLength(254)
export const newPassword = () => vine.string().minLength(8).maxLength(128)
