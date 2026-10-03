import { expect } from '@playwright/test'

/**
 * Mailpit de la pile locale (docker compose) : l'API y envoie les emails (invitations, mentions).
 * Sur un environnement déployé (SES), pas de boîte lisible : les parcours qui en ont besoin sont
 * sautés.
 */
export const MAILPIT_URL = process.env.E2E_MAILPIT_URL ?? 'http://localhost:8025'

interface MailpitSearch {
  messages: { ID: string; Subject: string }[]
}

interface MailpitMessage {
  Subject: string
  Text: string
  HTML: string
}

/** Email lu dans Mailpit : objet, texte brut et HTML. */
export interface Email {
  subject: string
  text: string
  html: string
}

/** Vrai si l'API de Mailpit répond. */
export async function mailpitAvailable(): Promise<boolean> {
  try {
    return (await fetch(`${MAILPIT_URL}/api/v1/info`)).ok
  } catch {
    return false
  }
}

/** Emails reçus par `email`, du plus récent au plus ancien. */
async function inbox(email: string): Promise<Email[]> {
  const query = new URLSearchParams({ query: `to:"${email}"` }).toString()
  const search = (await (
    await fetch(`${MAILPIT_URL}/api/v1/search?${query}`)
  ).json()) as MailpitSearch
  const emails: Email[] = []
  for (const { ID } of search.messages) {
    const message = (await (
      await fetch(`${MAILPIT_URL}/api/v1/message/${ID}`)
    ).json()) as MailpitMessage
    emails.push({ subject: message.Subject, text: message.Text, html: message.HTML })
  }
  return emails
}

/** Chemins des pages d'invitation (`/invitations/<jeton>`) reçus, du plus récent au plus ancien. */
async function findInvitations(email: string): Promise<string[]> {
  const paths: string[] = []
  for (const message of await inbox(email)) {
    const token = /\/invitations\/([A-Za-z0-9_-]{20,})/.exec(`${message.text}\n${message.html}`)
    if (token?.[1]) paths.push(`/invitations/${token[1]}`)
  }
  return paths
}

/**
 * Chemins des invitations reçues par `email` (du plus récent au plus ancien), une fois qu'il y en
 * a au moins `count`.
 */
export async function invitationPaths(email: string, count = 1): Promise<string[]> {
  // Objet plutôt que variable : TypeScript ne voit pas l'affectation faite dans le rappel.
  const found: { paths: string[] } = { paths: [] }
  await expect
    .poll(
      async () => {
        found.paths = await findInvitations(email)
        return found.paths.length
      },
      { timeout: 30_000, message: `${String(count)} invitation email(s) to ${email}` },
    )
    .toBeGreaterThanOrEqual(count)
  return found.paths
}

/** Chemin de la page d'invitation (`/invitations/<jeton>`) du dernier email reçu par `email`. */
export async function invitationPath(email: string): Promise<string> {
  const [latest] = await invitationPaths(email)
  if (latest === undefined) throw new Error(`no invitation email for ${email}`)
  return latest
}

/** Dernier email reçu par `email` dont l'objet contient `subject` (attendu jusqu'à 30 s). */
export async function waitForEmail(email: string, subject: string): Promise<Email> {
  const found: { email: Email | null } = { email: null }
  await expect
    .poll(
      async () => {
        found.email =
          (await inbox(email)).find((message) => message.subject.includes(subject)) ?? null
        return found.email
      },
      { timeout: 30_000, message: `email « ${subject} » to ${email}` },
    )
    .not.toBeNull()
  if (found.email === null) throw new Error(`no email « ${subject} » for ${email}`)
  return found.email
}

/** Chemin (et requête) du premier lien de l'application trouvé dans un email. */
export function appPathIn(email: Email, pattern: RegExp): string {
  const match = pattern.exec(`${email.text}\n${email.html}`)
  if (match === null) throw new Error(`no link matching ${String(pattern)} in « ${email.subject} »`)
  const url = new URL(match[0].replaceAll('&amp;', '&'))
  return `${url.pathname}${url.search}`
}
