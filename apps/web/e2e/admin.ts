import { expect, type Page } from '@playwright/test'
import { api } from './api'
import { signIn, type TestUser } from './clerk'

/** Origine de l'admin (`apps/admin`, port 3001 en local). */
export const ADMIN_URL = process.env.E2E_ADMIN_URL ?? 'http://localhost:3001'

export function adminUrl(path: string): string {
  return new URL(path, ADMIN_URL).toString()
}

/**
 * Connexion à l'admin par le composant Clerk : mot de passe, puis code TOTP (le compte de test doit
 * avoir la MFA). Arrivée sur `/users`, où le layout affiche l'admin ou « Accès refusé ».
 */
export async function signInAdmin(page: Page, user: TestUser): Promise<void> {
  const totp = user.totp
  if (totp === null) throw new Error(`${user.email} has no TOTP: the admin requires MFA`)
  await signIn(page, user.email, {
    signInUrl: adminUrl('/sign-in'),
    landing: /\/users$/,
    secondFactor: () => totp.next(),
  })
}

interface AdminBannerEntry {
  id: string
  message: string
}

/**
 * Supprime par l'API de l'admin (page sur l'admin, session admin) les bannières dont le message
 * commence par `prefix` : une bannière de parcours ne doit jamais rester affichée.
 */
export async function deleteBanners(page: Page, prefix: string): Promise<void> {
  const { banners } = await api<{ banners: AdminBannerEntry[] }>(
    page,
    'GET',
    '/admin/banners?page=1',
  )
  for (const banner of banners.filter((candidate) => candidate.message.startsWith(prefix))) {
    await api(page, 'DELETE', `/admin/banners/${banner.id}`)
  }
}

/** Fiche admin d'un utilisateur trouvé par son email (`/users?q=`, puis lien de la ligne). */
export async function openAdminUser(page: Page, email: string): Promise<void> {
  await page.goto(adminUrl(`/users?${new URLSearchParams({ q: email }).toString()}`))
  await page.getByRole('row').filter({ hasText: email }).getByRole('link', { name: email }).click()
  await expect(page).toHaveURL(/\/users\/[0-9a-f-]{36}$/)
  await expect(
    page.getByRole('button', { name: 'Révoquer les sessions', exact: true }),
  ).toBeVisible()
}

/**
 * Action de l'admin confirmée dans sa boîte : bouton de la page, titre de la boîte, bouton de
 * confirmation et, pour une action irréversible, texte à recopier.
 */
export async function confirmAdminAction(
  page: Page,
  action: { button: string; title: string; confirm: string; typed?: string },
): Promise<void> {
  await page.getByRole('main').getByRole('button', { name: action.button, exact: true }).click()
  const dialog = page.getByRole('dialog', { name: action.title })
  if (action.typed !== undefined) await dialog.getByRole('textbox').fill(action.typed)
  await dialog.getByRole('button', { name: action.confirm, exact: true }).click()
  await expect(dialog).toBeHidden()
}

/** Badge d'état de la fiche ouverte (utilisateur : Actif, Banni, Supprimé ; projet : Actif…). */
export function stateBadge(page: Page) {
  return page.getByRole('main').locator('[data-slot="badge"]').first()
}
