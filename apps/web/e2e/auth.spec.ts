import { clerk } from '@clerk/testing/playwright'
import { expect, test } from '@playwright/test'
import { deleteTestUserByEmail, signIn, signOut, signUp, testEmail, TotpDevice } from './clerk'

const email = testEmail('mfa')

// Compte créé par l'inscription : supprimé chez Clerk à la fin du parcours.
test.afterEach(async () => {
  await deleteTestUserByEmail(email)
})

test('a protected page sends an anonymous visitor to sign in, then back', async ({ page }) => {
  await page.goto('/dashboard')
  await expect(page).toHaveURL(/\/sign-in\?redirect_url=.*dashboard/)
  await expect(page.locator('input[name="identifier"]')).toBeVisible()
})

test('once MFA is enabled, signing in requires the TOTP code', async ({ page }) => {
  await signUp(page, { email, firstName: 'Grace', lastName: 'Hopper' })

  // Activation de la MFA (application d'authentification), comme le fait l'écran Sécurité de
  // <UserProfile /> : création du secret, puis vérification d'un premier code.
  await clerk.loaded({ page })
  const secret = await page.evaluate(async () => {
    const totp = await window.Clerk.user?.createTOTP()
    return totp?.secret ?? null
  })
  expect(secret).not.toBeNull()
  const totp = new TotpDevice(String(secret))
  const firstCode = await totp.next()
  await page.evaluate(async (code) => {
    await window.Clerk.user?.verifyTOTP({ code })
  }, firstCode)
  await page.goto('/account/security')
  await expect(page.locator('.cl-userProfile-root')).toBeVisible()

  await signOut(page)
  await signIn(page, email, { secondFactor: () => totp.next() })
  await expect(page.getByRole('button', { name: 'Nouveau projet', exact: true })).toBeVisible()
})
