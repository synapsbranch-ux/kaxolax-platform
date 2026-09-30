import { BaseMail } from '@adonisjs/mail'

export default class VerifyEmailNotification extends BaseMail {
  override subject = 'Confirmez votre compte Kaxolax'

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
        'Bienvenue sur Kaxolax !',
        '',
        'Confirmez votre adresse email en ouvrant ce lien (valable 24 heures) :',
        this.url,
        '',
        "Si vous n'avez pas créé de compte, ignorez cet email.",
      ].join('\n'),
    )
    this.message.html(
      '<p>Bienvenue sur Kaxolax !</p>' +
        '<p>Confirmez votre adresse email (le lien est valable 24 heures) :</p>' +
        `<p><a href="${this.url}">Confirmer mon adresse email</a></p>` +
        "<p>Si vous n'avez pas créé de compte, ignorez cet email.</p>",
    )
  }
}
