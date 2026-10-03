import env from '#start/env'
import { defineConfig, transports } from '@adonisjs/mail'

const username = env.get('SMTP_USERNAME')
const password = env.get('SMTP_PASSWORD')

/**
 * SMTP partout : Mailpit en local, fournisseur SMTP en production (`SMTP_PORT=465` avec
 * `SMTP_SECURE=true` : TLS dès la connexion). Le port 465 seul ne suffit pas : sans
 * `SMTP_SECURE=true`, nodemailer parle en clair et chaque envoi attend jusqu'au délai d'attente.
 */
const mailConfig = defineConfig({
  default: 'smtp',
  from: { address: env.get('MAIL_FROM_ADDRESS'), name: env.get('MAIL_FROM_NAME') },
  mailers: {
    smtp: transports.smtp({
      host: env.get('SMTP_HOST'),
      port: env.get('SMTP_PORT'),
      secure: env.get('SMTP_SECURE') === true,
      ...(username && password
        ? { auth: { type: 'login' as const, user: username, pass: password.release() } }
        : {}),
    }),
  },
})

export default mailConfig

declare module '@adonisjs/mail/types' {
  export interface MailersList extends InferMailers<typeof mailConfig> {}
}
