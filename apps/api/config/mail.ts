import env from '#start/env'
import { defineConfig, transports } from '@adonisjs/mail'

const username = env.get('SMTP_USERNAME')
const password = env.get('SMTP_PASSWORD')

/** SMTP partout : Mailpit en local, Amazon SES (interface SMTP) en staging. */
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
