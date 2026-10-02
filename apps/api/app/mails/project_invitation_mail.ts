import type { AssignableRole } from '@kaxolax/contracts'
import { BaseMail } from '@adonisjs/mail'

/** Libellé français de chaque rôle, avec ce qu'il permet. */
const ROLE_LABELS: Record<AssignableRole, string> = {
  editor: 'éditeur (modifier et compiler)',
  reviewer: 'relecteur (lire, compiler et commenter)',
  viewer: 'lecteur (lire et compiler)',
}

function escapeHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

export interface ProjectInvitationMailData {
  to: string
  projectName: string
  inviterName: string | null
  role: AssignableRole
  /** `${APP_URL}/invitations/<jeton>`. */
  url: string
  expiresInDays: number
}

/** Email d'invitation à un projet (en français ; texte brut et HTML). */
export default class ProjectInvitationMail extends BaseMail {
  constructor(readonly data: ProjectInvitationMailData) {
    super()
    this.subject = `${data.inviterName ?? 'Quelqu’un'} vous invite sur « ${data.projectName} » — Kaxolax`
  }

  prepare() {
    const { to, projectName, inviterName, role, url, expiresInDays } = this.data
    const inviter = inviterName ?? 'Un utilisateur de Kaxolax'
    const lines = [
      'Bonjour,',
      '',
      `${inviter} vous invite à rejoindre le projet « ${projectName} » sur Kaxolax, en tant que ${ROLE_LABELS[role]}.`,
      '',
      `Pour accepter l’invitation : ${url}`,
      '',
      `Ce lien est valable ${String(expiresInDays)} jours. Si vous n’avez pas encore de compte, créez-le avec cette adresse email : vous rejoindrez le projet automatiquement.`,
      '',
      'Si vous ne vous attendiez pas à cette invitation, ignorez simplement cet email.',
    ]
    this.message
      .to(to)
      .text(lines.join('\n'))
      .html(
        [
          '<p>Bonjour,</p>',
          `<p>${escapeHtml(inviter)} vous invite à rejoindre le projet « <strong>${escapeHtml(projectName)}</strong> » sur Kaxolax, en tant que ${escapeHtml(ROLE_LABELS[role])}.</p>`,
          `<p><a href="${escapeHtml(url)}">Accepter l’invitation</a></p>`,
          `<p>Ce lien est valable ${String(expiresInDays)} jours. Si vous n’avez pas encore de compte, créez-le avec cette adresse email : vous rejoindrez le projet automatiquement.</p>`,
          '<p>Si vous ne vous attendiez pas à cette invitation, ignorez simplement cet email.</p>',
        ].join('\n'),
      )
  }
}
