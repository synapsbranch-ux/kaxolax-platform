import { clerk } from '@clerk/testing/playwright'
import {
  type Browser,
  type BrowserContext,
  type BrowserContextOptions,
  test as base,
  expect,
  type Page,
} from '@playwright/test'
import { api, type ApiUser, deleteOwnedProjects } from './api'
import {
  createTestUser,
  deleteTestUser,
  signIn as signInWithPassword,
  type TestUser,
  type TestUserOptions,
} from './clerk'

/** Personnes des parcours : un prénom et un nom lisibles dans la présence, le chat, l'historique. */
export const PEOPLE = {
  ada: { firstName: 'Ada', lastName: 'Lovelace' },
  grace: { firstName: 'Grace', lastName: 'Hopper' },
  alan: { firstName: 'Alan', lastName: 'Turing' },
  katherine: { firstName: 'Katherine', lastName: 'Johnson' },
  edsger: { firstName: 'Edsger', lastName: 'Dijkstra' },
} as const satisfies Record<string, { firstName: string; lastName: string }>

/**
 * Compte de test connecté dans son propre contexte de navigateur (cookies et stockage séparés) :
 * plusieurs personnes peuvent travailler en même temps sur le même projet.
 */
export interface Account {
  user: TestUser
  /** Identifiant de l'utilisateur dans l'API (miroir local du compte Clerk). */
  id: string
  /** Nom affiché par l'application (présence, chat, membres). */
  name: string
  email: string
  context: BrowserContext
  page: Page
}

export interface CreateAccountOptions extends Partial<TestUserOptions> {
  /** Options du contexte (taille de l'écran, thème…), ajoutées à celles du parcours. */
  contextOptions?: BrowserContextOptions
  /** Ne pas se connecter à l'application (compte réservé à l'admin, par exemple). */
  signedOut?: boolean
}

/**
 * Comptes d'un parcours : créés par l'API Backend de Clerk, connectés (jeton de connexion de
 * `@clerk/testing`, ou mot de passe et TOTP pour un compte avec MFA) chacun dans un contexte, puis
 * nettoyés à la fin : projets possédés supprimés, contextes fermés, comptes Clerk supprimés.
 */
export class Accounts {
  private readonly created: Account[] = []
  /** Contextes supplémentaires (autre taille d'écran, autre thème) des comptes créés. */
  private readonly sessions: BrowserContext[] = []

  constructor(
    private readonly browser: Browser,
    private readonly contextOptions: BrowserContextOptions,
  ) {}

  async create(options: CreateAccountOptions = {}): Promise<Account> {
    const { contextOptions, signedOut, ...person } = options
    const user = await createTestUser({ ...PEOPLE.ada, ...person })
    const context = await this.browser.newContext({ ...this.contextOptions, ...contextOptions })
    const page = await context.newPage()
    const account: Account = {
      user,
      id: '',
      name: user.fullName,
      email: user.email,
      context,
      page,
    }
    this.created.push(account)
    if (signedOut === true) return account
    await this.signIn(account)
    return account
  }

  /** Connecte le compte à l'application et lit son identifiant dans l'API. */
  async signIn(account: Account): Promise<void> {
    const me = await signInPage(account.page, account.user)
    account.id = me.id
    account.name = me.fullName ?? me.email
  }

  /**
   * Nouvelle session du même compte dans un autre contexte (taille d'écran, thème…), fermée au
   * nettoyage ; la page arrive sur le tableau de bord.
   */
  async session(account: Account, contextOptions: BrowserContextOptions = {}): Promise<Page> {
    const context = await this.browser.newContext({ ...this.contextOptions, ...contextOptions })
    this.sessions.push(context)
    const page = await context.newPage()
    await signInPage(page, account.user)
    return page
  }

  /** Page d'un nouveau contexte, sans connexion (admin, visiteur), fermé au nettoyage. */
  async blankPage(contextOptions: BrowserContextOptions = {}): Promise<Page> {
    const context = await this.browser.newContext({ ...this.contextOptions, ...contextOptions })
    this.sessions.push(context)
    return context.newPage()
  }

  /** Ramène la page sur l'application (tableau de bord) si elle n'y est plus. */
  private async backToApp(page: Page): Promise<void> {
    const app = this.contextOptions.baseURL
    const url = page.url()
    if (app !== undefined && url.startsWith(new URL(app).origin) && !url.includes('/sign-in')) {
      return
    }
    await page.goto('/dashboard')
  }

  /** Nettoyage, au mieux : une étape en échec n'empêche pas les suivantes. */
  async dispose(): Promise<void> {
    for (const account of this.created) {
      try {
        if (account.id !== '') {
          await this.backToApp(account.page)
          await deleteOwnedProjects(account.page)
        }
      } catch (error) {
        console.warn(`could not delete the projects of ${account.email}`, error)
      }
    }
    for (const context of this.sessions) await context.close().catch(() => undefined)
    for (const account of this.created) {
      await account.context.close().catch(() => undefined)
      await deleteTestUser(account.user.clerkId)
    }
    this.sessions.length = 0
    this.created.length = 0
  }
}

/**
 * Connecte la page à l'application : jeton de connexion de `@clerk/testing` (sans second facteur),
 * ou mot de passe et code TOTP pour un compte avec MFA. Renvoie le compte vu par l'API.
 */
async function signInPage(page: Page, user: TestUser): Promise<ApiUser> {
  if (user.totp === null) {
    await page.goto('/sign-in')
    await clerk.signIn({ page, emailAddress: user.email })
    await page.goto('/dashboard')
    await expect(page).toHaveURL(/\/dashboard$/)
  } else {
    const totp = user.totp
    await signInWithPassword(page, user.email, { secondFactor: () => totp.next() })
  }
  return (await api<{ user: ApiUser }>(page, 'GET', '/me')).user
}

/**
 * `test` des parcours : fixture `accounts` (comptes créés à la demande, nettoyés après le
 * parcours) dans des contextes qui reprennent les réglages du projet Playwright.
 */
export const test = base.extend<{ accounts: Accounts }>({
  accounts: async ({ browser, baseURL, viewport, locale, timezoneId }, provide) => {
    const accounts = new Accounts(browser, {
      baseURL,
      viewport,
      locale,
      timezoneId,
      acceptDownloads: true,
    })
    await provide(accounts)
    await accounts.dispose()
  },
})

export { expect }
