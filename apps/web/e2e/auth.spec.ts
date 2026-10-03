import { clerk } from '@clerk/testing/playwright'
import { expect, test } from '@playwright/test'
import { Secret, TOTP } from 'otpauth'
import { signIn, signOut, signUp, testEmail } from './clerk'

/** Code TOTP d'une période qui n'a pas encore servi (Clerk refuse un code déjà utilisé). */
async function freshCode(totp: TOTP, used: Set<string>): Promise<string> {
  for (;;) {
    const code = totp.generate()
    if (!used.has(code)) {
      used.add(code)
      return code
    }
    await new Promise((resolve) => setTimeout(resolve, 1000))
  }
}

test('a protected page sends an anonymous visitor to sign in, then back', async ({ page }) => {
  await page.goto('/dashboard')
  await expect(page).toHaveURL(/\/sign-in\?redirect_url=.*dashboard/)
  await expect(page.locator('input[name="identifier"]')).toBeVisible()
})

test('once MFA is enabled, signing in requires the TOTP code', async ({ page }) => {
  const email = testEmail('mfa')
  await signUp(page, { email, firstName: 'Grace', lastName: 'Hopper' })

  // Activation de la MFA (application d'authentification), comme le fait l'écran Sécurité de
  // <UserProfile /> : création du secret, puis vérification d'un premier code.
  await clerk.loaded({ page })
  const secret = await page.evaluate(async () => {
    const totp = await window.Clerk.user?.createTOTP()
    return totp?.secret ?? null
  })
  expect(secret).not.toBeNull()
  const totp = new TOTP({ secret: Secret.fromBase32(String(secret)) })
  const used = new Set<string>()
  const firstCode = await freshCode(totp, used)
  await page.evaluate(async (code) => {
    await window.Clerk.user?.verifyTOTP({ code })
  }, firstCode)
  await page.goto('/account/security')
  await expect(page.locator('.cl-userProfile-root')).toBeVisible()

  await signOut(page)
  await signIn(page, email, { secondFactor: () => freshCode(totp, used) })
  await expect(page.getByRole('button', { name: 'Nouveau projet', exact: true })).toBeVisible()
})
