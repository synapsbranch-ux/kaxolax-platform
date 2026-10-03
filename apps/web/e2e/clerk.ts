import { randomUUID } from 'node:crypto'
import { type ClerkClient, createClerkClient } from '@clerk/backend'
import { setupClerkTestingToken } from '@clerk/testing/playwright'
import type { ADMIN_ROLE } from '@kaxolax/contracts'
import { expect, type Page } from '@playwright/test'
import { Secret, TOTP } from 'otpauth'

/**
 * Parcours d'authentification par les composants Clerk (instance de développement). Les adresses
 * `+clerk_test` ne reçoivent aucun email : leur code de vérification est toujours 424242.
 * Sélecteurs : attributs `name` des champs et classes `cl-*` de Clerk, indépendants de la langue.
 * Les comptes des parcours multi-utilisateurs sont créés (et supprimés) par l'API Backend de Clerk.
 */
export const TEST_CODE = '424242'
export const PASSWORD = 'Kaxolax-e2e-correct-horse-battery'

/** Rôle de l'admin (`publicMetadata.role`, `ADMIN_ROLE` des contrats). */
const ADMIN: typeof ADMIN_ROLE = 'admin'

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

/** Personne qui s'inscrit par le composant Clerk. */
export interface SignUpPerson {
  email: string
  firstName: string
  lastName: string
}

export async function signUp(page: Page, person: SignUpPerson): Promise<void> {
  await setupClerkTestingToken({ page })
  await page.goto('/sign-up')
  await fillSignUpForm(page, person)
  await expect(page).toHaveURL(/\/dashboard$/)
}

/**
 * Remplit le formulaire d'inscription de Clerk déjà affiché (jeton de test posé avant la
 * navigation) et saisit le code de vérification ; l'arrivée dépend de la page qui l'a ouvert.
 */
export async function fillSignUpForm(
  page: Page,
  { email, firstName, lastName }: SignUpPerson,
): Promise<void> {
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
}

export interface SignInOptions {
  /** Second facteur demandé par Clerk (code TOTP). */
  secondFactor?: () => Promise<string>
  /** Page de connexion (absolue pour l'admin) ; défaut : `/sign-in` de l'application. */
  signInUrl?: string
  /** Adresse d'arrivée après la connexion ; défaut : le tableau de bord. */
  landing?: RegExp
}

/**
 * Connexion par email et mot de passe. Un second facteur (TOTP) est saisi s'il est demandé ; une
 * vérification d'appareil (code par email) aussi, avec le code de test.
 */
export async function signIn(
  page: Page,
  email: string,
  options: SignInOptions = {},
): Promise<void> {
  const landing = options.landing ?? /\/dashboard$/
  await setupClerkTestingToken({ page })
  await page.goto(options.signInUrl ?? '/sign-in')
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
      page.waitForURL(landing).catch(() => undefined),
      code.waitFor().catch(() => undefined),
    ])
    if (!landing.test(new URL(page.url()).pathname)) await typeCode(page, TEST_CODE)
  }
  await expect(page).toHaveURL(landing)
}

/**
 * Tentative de connexion par mot de passe qui doit échouer (compte banni) : Clerk affiche une
 * erreur, à l'identifiant ou au mot de passe, et la page reste sur la connexion.
 */
export async function expectSignInRefused(page: Page, email: string): Promise<void> {
  await setupClerkTestingToken({ page })
  await page.goto('/sign-in')
  await page.locator('input[name="identifier"]').fill(email)
  await primaryButton(page).click()
  const password = page.locator('input[name="password"]')
  const error = page.locator('.cl-formFieldErrorText, .cl-alert').first()
  await expect(password.or(error).first()).toBeVisible()
  if (await password.isVisible()) {
    await password.fill(PASSWORD)
    await primaryButton(page).click()
  }
  await expect(error).toBeVisible()
  await expect(page).toHaveURL(/\/sign-in/)
}

/** Déconnexion par le menu du compte (UserButton). */
export async function signOut(page: Page): Promise<void> {
  await page.locator('.cl-userButtonTrigger').click()
  await page.locator('.cl-userButtonPopoverActionButton__signOut').click()
  await expect(page).toHaveURL(/\/sign-in/)
}

// --- API Backend de Clerk -----------------------------------------------------------------------

let backend: ClerkClient | null = null

/** Client de l'API Backend de Clerk (instance de développement, `CLERK_SECRET_KEY`). */
export function clerkBackend(): ClerkClient {
  if (backend === null) {
    const secretKey = process.env.CLERK_SECRET_KEY
    if (!secretKey) throw new Error('CLERK_SECRET_KEY is required to manage the test accounts')
    backend = createClerkClient({ secretKey })
  }
  return backend
}

/**
 * Générateur de codes TOTP d'un compte de test : chaque code est d'une période qui n'a pas encore
 * servi (Clerk refuse un code déjà utilisé), quitte à attendre la période suivante.
 */
export class TotpDevice {
  private readonly totp: TOTP
  private readonly used = new Set<string>()

  constructor(readonly secret: string) {
    this.totp = new TOTP({ secret: Secret.fromBase32(secret) })
  }

  /** Nouvel appareil avec un secret aléatoire (base32). */
  static create(): TotpDevice {
    return new TotpDevice(new Secret({ size: 20 }).base32)
  }

  async next(): Promise<string> {
    for (;;) {
      const code = this.totp.generate()
      if (!this.used.has(code)) {
        this.used.add(code)
        return code
      }
      await new Promise((resolve) => setTimeout(resolve, 1_000))
    }
  }
}

/** Compte de test créé par l'API Backend (adresse `+clerk_test`, email vérifié). */
export interface TestUser {
  clerkId: string
  email: string
  firstName: string
  lastName: string
  /** Nom affiché par l'application (claim `name` du jeton de session). */
  fullName: string
  /** Second facteur TOTP activé à la création, sinon null. */
  totp: TotpDevice | null
}

export interface TestUserOptions {
  firstName: string
  lastName: string
  /** Préfixe de l'adresse (défaut : le prénom en minuscules). */
  prefix?: string
  /** Active la MFA (TOTP) dès la création. */
  totp?: boolean
  /** Donne le rôle admin (`publicMetadata.role`). */
  admin?: boolean
}

/**
 * Crée un compte de test par l'API Backend : email vérifié, mot de passe `PASSWORD`, et au besoin
 * un secret TOTP (MFA activée sans passer par l'écran Sécurité) et le rôle admin.
 */
export async function createTestUser(options: TestUserOptions): Promise<TestUser> {
  const email = testEmail(options.prefix ?? options.firstName.toLowerCase())
  const totp = options.totp === true ? TotpDevice.create() : null
  const user = await clerkBackend().users.createUser({
    emailAddress: [email],
    password: PASSWORD,
    firstName: options.firstName,
    lastName: options.lastName,
    skipPasswordChecks: true,
    skipLegalChecks: true,
    ...(totp === null ? {} : { totpSecret: totp.secret }),
    ...(options.admin === true ? { publicMetadata: { role: ADMIN } } : {}),
  })
  return {
    clerkId: user.id,
    email,
    firstName: options.firstName,
    lastName: options.lastName,
    fullName: `${options.firstName} ${options.lastName}`,
    totp,
  }
}

/** Donne le rôle admin à un compte existant (pris en compte à sa prochaine session). */
export async function grantAdminRole(clerkId: string): Promise<void> {
  await clerkBackend().users.updateUserMetadata(clerkId, { publicMetadata: { role: ADMIN } })
}

/** Supprime un compte de test chez Clerk (sans erreur s'il n'existe plus). */
export async function deleteTestUser(clerkId: string): Promise<void> {
  try {
    await clerkBackend().users.deleteUser(clerkId)
  } catch (error) {
    console.warn(`could not delete the Clerk test user ${clerkId}`, error)
  }
}

/** Supprime les comptes Clerk d'une adresse (comptes créés par l'interface d'inscription). */
export async function deleteTestUserByEmail(email: string): Promise<void> {
  const { data } = await clerkBackend().users.getUserList({ emailAddress: [email] })
  for (const user of data) await deleteTestUser(user.id)
}
