import { BaseMail } from '@adonisjs/mail'

function escapeHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

export interface ChatMentionMailData {
  to: string
  projectName: string
  authorName: string | null
  /** Extrait du message, mentions remplacées par les noms (texte brut). */
  excerpt: string
  /** `${APP_URL}/project/<id>?panel=chat`. */
  url: string
}

/** Notification d'une @mention dans le chat d'un projet (en français ; texte brut et HTML). */
export default class ChatMentionMail extends BaseMail {
  constructor(readonly data: ChatMentionMailData) {
    super()
    this.subject = `${data.authorName ?? 'Quelqu’un'} vous a mentionné dans « ${data.projectName} » — Kaxolax`
  }

  prepare() {
    const { to, projectName, authorName, excerpt, url } = this.data
    const author = authorName ?? 'Un membre du projet'
    const footer =
      'Vous recevez au plus un email par série de mentions, jusqu’à votre prochaine lecture du chat.'
    this.message
      .to(to)
      .text(
        [
          'Bonjour,',
          '',
          `${author} vous a mentionné dans le chat du projet « ${projectName} » :`,
          '',
          excerpt
            .split('\n')
            .map((line) => `> ${line}`)
            .join('\n'),
          '',
          `Pour répondre : ${url}`,
          '',
          footer,
        ].join('\n'),
      )
      .html(
        [
          '<p>Bonjour,</p>',
          `<p>${escapeHtml(author)} vous a mentionné dans le chat du projet « <strong>${escapeHtml(projectName)}</strong> » :</p>`,
          `<blockquote style="white-space:pre-wrap">${escapeHtml(excerpt)}</blockquote>`,
          `<p><a href="${escapeHtml(url)}">Ouvrir le chat</a></p>`,
          `<p>${escapeHtml(footer)}</p>`,
        ].join('\n'),
      )
  }
}
