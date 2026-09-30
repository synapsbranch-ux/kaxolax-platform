import vine from '@vinejs/vine'
import { email, newPassword, singleLineRule } from '#validators/rules'

export const registerValidator = vine.create({
  email: email().unique({ table: 'users', column: 'email' }),
  password: newPassword(),
  fullName: vine
    .string()
    .trim()
    .minLength(1)
    .maxLength(255)
    .use(singleLineRule())
    .nullable()
    .optional(),
})

export const loginValidator = vine.create({
  email: email(),
  password: vine.string().maxLength(128),
})

export const emailValidator = vine.create({
  email: email(),
})

export const tokenValidator = vine.create({
  token: vine.string().minLength(16).maxLength(128),
})

export const resetPasswordValidator = vine.create({
  token: vine.string().minLength(16).maxLength(128),
  password: newPassword(),
})
