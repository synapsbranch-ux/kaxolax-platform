import { BaseMail } from '@adonisjs/mail'

export default class ResetPasswordNotification extends BaseMail {
  override subject = 'Réinitialisez votre mot de passe Kaxolax'

  constructor(
    private readonly email: string,
    readonly url: string,
  ) {
    super()
  }

  prepare() {
    this.message.to(this.email)
    this.message.text(
      [
        'Une réinitialisation du mot de passe de votre compte Kaxolax a été demandée.',
        '',
        'Choisissez un nouveau mot de passe en ouvrant ce lien (valable 1 heure) :',
        this.url,
        '',
        "Si vous n'êtes pas à l'origine de cette demande, ignorez cet email : votre mot de passe reste inchangé.",
      ].join('\n'),
    )
    this.message.html(
      '<p>Une réinitialisation du mot de passe de votre compte Kaxolax a été demandée.</p>' +
        `<p><a href="${this.url}">Choisir un nouveau mot de passe</a> (le lien est valable 1 heure).</p>` +
        "<p>Si vous n'êtes pas à l'origine de cette demande, ignorez cet email : votre mot de passe reste inchangé.</p>",
    )
  }
}
