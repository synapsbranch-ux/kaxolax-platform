import { Exception } from '@adonisjs/core/exceptions'
import type { HttpContext } from '@adonisjs/core/http'
import mail from '@adonisjs/mail/services/main'
import { DateTime } from 'luxon'
import { appUrl } from '#config/app'
import ResetPasswordNotification from '#mails/reset_password_notification'
import VerifyEmailNotification from '#mails/verify_email_notification'
import User from '#models/user'
import { serializeUser } from '#controllers/me_controller'
import { consumeToken, issueToken } from '#services/auth_tokens'
import {
  emailValidator,
  loginValidator,
  registerValidator,
  resetPasswordValidator,
  tokenValidator,
} from '#validators/auth'

export class EmailNotVerifiedException extends Exception {
  static override status = 403
  static override code = 'E_EMAIL_NOT_VERIFIED'
  static override message = 'Confirm your email address before logging in'
}

export class InvalidTokenException extends Exception {
  static override status = 400
  static override code = 'E_INVALID_TOKEN'
  static override message = 'This link is invalid or has expired'
}

async function sendVerificationEmail(user: User) {
  const token = await issueToken(user, 'email_verification')
  await mail.send(new VerifyEmailNotification(user.email, `${appUrl}/verify-email?token=${token}`))
}

export default class AuthController {
  async register({ request, response }: HttpContext) {
    const { email, password, fullName } = await request.validateUsing(registerValidator)
    const user = await User.create({ email, passwordHash: password, fullName: fullName ?? null })
    await sendVerificationEmail(user)
    response.created({ user: serializeUser(user) })
  }

  async login({ request, auth }: HttpContext) {
    const { email, password } = await request.validateUsing(loginValidator)
    const user = await User.verifyCredentials(email, password)
    if (user.emailVerifiedAt === null) throw new EmailNotVerifiedException()
    await auth.use('web').login(user)
    return { user: serializeUser(user) }
  }

  async logout({ auth, response }: HttpContext) {
    await auth.use('web').logout()
    response.noContent()
  }

  me({ auth }: HttpContext) {
    return { user: serializeUser(auth.getUserOrFail()) }
  }

  async verifyEmail({ request }: HttpContext) {
    const { token } = await request.validateUsing(tokenValidator)
    const user = await consumeToken('email_verification', token)
    if (!user) throw new InvalidTokenException()
    user.emailVerifiedAt ??= DateTime.utc()
    await user.save()
    return { user: serializeUser(user) }
  }

  /** Réponse identique que le compte existe ou non (pas d'énumération des emails). */
  async resendVerification({ request, response }: HttpContext) {
    const { email } = await request.validateUsing(emailValidator)
    const user = await User.findBy('email', email)
    if (user?.emailVerifiedAt === null) await sendVerificationEmail(user)
    response.accepted({ sent: true })
  }

  async forgotPassword({ request, response }: HttpContext) {
    const { email } = await request.validateUsing(emailValidator)
    const user = await User.findBy('email', email)
    if (user) {
      const token = await issueToken(user, 'password_reset')
      await mail.send(
        new ResetPasswordNotification(user.email, `${appUrl}/reset-password?token=${token}`),
      )
    }
    response.accepted({ sent: true })
  }

  async resetPassword({ request }: HttpContext) {
    const { token, password } = await request.validateUsing(resetPasswordValidator)
    const user = await consumeToken('password_reset', token)
    if (!user) throw new InvalidTokenException()
    user.passwordHash = password
    // Le lien reçu par email prouve la possession de l'adresse.
    user.emailVerifiedAt ??= DateTime.utc()
    await user.save()
    return { user: serializeUser(user) }
  }
}
