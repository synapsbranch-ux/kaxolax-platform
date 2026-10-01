import { SPELLCHECK_LANGUAGES } from '@kaxolax/contracts'
import vine from '@vinejs/vine'
import { singleLineRule } from '#validators/rules'

const projectName = () => vine.string().trim().minLength(1).maxLength(255).use(singleLineRule())

export const listProjectsValidator = vine.create({
  view: vine.enum(['active', 'archived', 'trashed'] as const).optional(),
  q: vine.string().maxLength(255).optional(),
  workspaceId: vine.string().uuid().optional(),
})

export const createProjectValidator = vine.create({
  name: projectName(),
  /** Absent : workspace personnel du créateur. */
  workspaceId: vine.string().uuid().optional(),
})

export const updateProjectValidator = vine.create({
  name: projectName().optional(),
  compiler: vine.enum(['pdflatex', 'xelatex', 'lualatex'] as const).optional(),
  mainDocumentId: vine.string().uuid().optional(),
  spellcheckLanguage: vine.enum(SPELLCHECK_LANGUAGES).optional(),
})
