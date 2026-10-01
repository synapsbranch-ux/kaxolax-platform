import { randomUUID } from 'node:crypto'
import { setupClerkTestingToken } from '@clerk/testing/playwright'
import { expect, type Page } from '@playwright/test'

/**
 * Parcours d'authentification par les composants Clerk (instance de développement). Les adresses
 * `+clerk_test` ne reçoivent aucun email : leur code de vérification est toujours 424242.
 * Sélecteurs : attributs `name` des champs et classes `cl-*` de Clerk, indépendants de la langue.
 */
export const TEST_CODE = '424242'
export const PASSWORD = 'Kaxolax-e2e-correct-horse-battery'

export function testEmail(prefix: string): string {
  return `${prefix}+clerk_test_${randomUUID().slice(0, 8)}@example.com`
}

const primaryButton = (page: Page) => page.locator('.cl-formButtonPrimary')

/** Saisit un code à usage unique dans le champ OTP de Clerk (focalisé à l'affichage). */
export async function typeCode(page: Page, code: string): Promise<void> {
  const field = page.locator('input[autocomplete="one-time-code"]').first()
  await expect(field).toBeVisible()
  await field.click()
  await page.keyboard.type(code)
}

export async function signUp(
  page: Page,
  { email, firstName, lastName }: { email: string; firstName: string; lastName: string },
): Promise<void> {
  await setupClerkTestingToken({ page })
  await page.goto('/sign-up')
  await expect(page.locator('input[name="emailAddress"]')).toBeVisible()
  // Prénom et nom n'apparaissent que si l'instance les demande.
  const first = page.locator('input[name="firstName"]')
  if (await first.isVisible()) await first.fill(firstName)
  const last = page.locator('input[name="lastName"]')
  if (await last.isVisible()) await last.fill(lastName)
  await page.locator('input[name="emailAddress"]').fill(email)
  await page.locator('input[name="password"]').fill(PASSWORD)
  await primaryButton(page).click()
  await typeCode(page, TEST_CODE)
  await expect(page).toHaveURL(/\/dashboard$/)
}

/**
 * Connexion par email et mot de passe. Un second facteur (TOTP) est saisi s'il est demandé ; une
 * vérification d'appareil (code par email) aussi, avec le code de test.
 */
export async function signIn(
  page: Page,
  email: string,
  options: { secondFactor?: () => Promise<string> } = {},
): Promise<void> {
  await setupClerkTestingToken({ page })
  await page.goto('/sign-in')
  await page.locator('input[name="identifier"]').fill(email)
  await primaryButton(page).click()
  await page.locator('input[name="password"]').fill(PASSWORD)
  await primaryButton(page).click()
  if (options.secondFactor) {
    await expect(page).toHaveURL(/\/sign-in\/factor-two/)
    await typeCode(page, await options.secondFactor())
  } else {
    // Selon l'instance, Clerk peut demander de vérifier le nouvel appareil par un code.
    const code = page.locator('input[autocomplete="one-time-code"]').first()
    await Promise.race([
      page.waitForURL(/\/dashboard$/).catch(() => undefined),
      code.waitFor().catch(() => undefined),
    ])
    if (!new URL(page.url()).pathname.endsWith('/dashboard')) await typeCode(page, TEST_CODE)
  }
  await expect(page).toHaveURL(/\/dashboard$/)
}

/** Déconnexion par le menu du compte (UserButton). */
export async function signOut(page: Page): Promise<void> {
  await page.locator('.cl-userButtonTrigger').click()
  await page.locator('.cl-userButtonPopoverActionButton__signOut').click()
  await expect(page).toHaveURL(/\/sign-in/)
}
