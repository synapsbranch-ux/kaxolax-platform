import { BaseMail } from '@adonisjs/mail'

function escapeHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

function quoteLines(text: string): string {
  return text
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n')
}

export interface CommentMentionMailData {
  to: string
  projectName: string
  documentName: string
  authorName: string | null
  /** Citation du texte commenté (bornée). */
  quotedText: string
  /** Extrait du commentaire, mentions remplacées par les noms (texte brut). */
  excerpt: string
  /** `${APP_URL}/project/<id>?comment=<threadId>`. */
  url: string
}

/** Notification d'une @mention dans un commentaire (en français ; texte brut et HTML). */
export default class CommentMentionMail extends BaseMail {
  constructor(readonly data: CommentMentionMailData) {
    super()
    this.subject = `${data.authorName ?? 'Quelqu’un'} vous a mentionné dans un commentaire de « ${data.projectName} » — Kaxolax`
  }

  prepare() {
    const { to, projectName, documentName, authorName, quotedText, excerpt, url } = this.data
    const author = authorName ?? 'Un membre du projet'
    const footer = `Vous recevez au plus un email de mention de commentaire par période de quelques minutes et par projet.`
    this.message
      .to(to)
      .text(
        [
          'Bonjour,',
          '',
          `${author} vous a mentionné dans un commentaire sur ${documentName}, projet « ${projectName} ».`,
          '',
          'Texte commenté :',
          quoteLines(quotedText),
          '',
          'Commentaire :',
          quoteLines(excerpt),
          '',
          `Pour répondre : ${url}`,
          '',
          footer,
        ].join('\n'),
      )
      .html(
        [
          '<p>Bonjour,</p>',
          `<p>${escapeHtml(author)} vous a mentionné dans un commentaire sur <code>${escapeHtml(documentName)}</code>, projet « <strong>${escapeHtml(projectName)}</strong> ».</p>`,
          `<p>Texte commenté :</p>`,
          `<blockquote style="white-space:pre-wrap;color:#555">${escapeHtml(quotedText)}</blockquote>`,
          `<p>Commentaire :</p>`,
          `<blockquote style="white-space:pre-wrap">${escapeHtml(excerpt)}</blockquote>`,
          `<p><a href="${escapeHtml(url)}">Ouvrir le commentaire</a></p>`,
          `<p>${escapeHtml(footer)}</p>`,
        ].join('\n'),
      )
  }
}
