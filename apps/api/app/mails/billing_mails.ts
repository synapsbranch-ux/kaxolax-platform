import { BaseMail } from '@adonisjs/mail'

function escapeHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

export interface BillingMailData {
  to: string
  fullName: string | null
  /** Nom du plan dans Clerk (« Pro »), ou son slug. */
  planName: string
  /** Page de facturation : onglet Billing du profil (`${APP_URL}/account/billing`). */
  billingUrl: string
}

/** Texte brut et HTML à partir des mêmes paragraphes (le lien est ajouté avant la fin). */
function render(
  mail: BaseMail,
  to: string,
  paragraphs: string[],
  link: { label: string; url: string },
) {
  mail.message
    .to(to)
    .text([...paragraphs, `${link.label} : ${link.url}`, '', 'L’équipe Kaxolax'].join('\n\n'))
    .html(
      [
        ...paragraphs.map((paragraph) => `<p>${escapeHtml(paragraph)}</p>`),
        `<p><a href="${escapeHtml(link.url)}">${escapeHtml(link.label)}</a></p>`,
        '<p>L’équipe Kaxolax</p>',
      ].join('\n'),
    )
}

/** Bienvenue dans le plan payant (abonnement devenu actif). */
export class ProWelcomeMail extends BaseMail {
  constructor(readonly data: BillingMailData) {
    super()
    this.subject = `Bienvenue dans Kaxolax ${data.planName}`
  }

  prepare() {
    const { to, fullName, planName, billingUrl } = this.data
    render(
      this,
      to,
      [
        `Bonjour${fullName ? ` ${fullName}` : ''},`,
        `Merci pour votre abonnement : votre compte est passé au plan ${planName}.`,
        'Compilations plus longues, collaborateurs illimités, historique complet et stockage étendu s’appliquent dès maintenant à tous vos projets.',
        'Vos factures, votre moyen de paiement et votre abonnement se gèrent depuis votre compte.',
      ],
      { label: 'Gérer mon abonnement', url: billingUrl },
    )
  }
}

/** Paiement en retard : l'accès est conservé pendant que Clerk retente le prélèvement. */
export class PaymentPastDueMail extends BaseMail {
  constructor(readonly data: BillingMailData) {
    super()
    this.subject = `Paiement en attente pour votre abonnement Kaxolax ${data.planName}`
  }

  prepare() {
    const { to, fullName, planName, billingUrl } = this.data
    render(
      this,
      to,
      [
        `Bonjour${fullName ? ` ${fullName}` : ''},`,
        `Le dernier paiement de votre abonnement ${planName} n’a pas abouti.`,
        'Votre accès est conservé pour l’instant. Mettez à jour votre moyen de paiement pour éviter que votre compte ne repasse au plan gratuit.',
      ],
      { label: 'Mettre à jour mon moyen de paiement', url: billingUrl },
    )
  }
}
