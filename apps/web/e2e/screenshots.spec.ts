import { join } from 'node:path'
import { type BrowserContextOptions, expect, type Page, test } from '@playwright/test'
import { type Account, Accounts, PEOPLE } from './accounts'
import { adminUrl, deleteBanners, signInAdmin } from './admin'
import { api, ApiCallError } from './api'
import { testEmail } from './clerk'
import { DEMO_NAME, demoProjectFiles } from './demo'
import { invitationPath, mailpitAvailable } from './mailpit'
import {
  addMember,
  appendToEditor,
  commentSelection,
  commentThread,
  compile,
  enableShareLink,
  expectPdfText,
  importProject,
  openInTree,
  openProject,
  openReview,
  placeCursorAfter,
  placeCursorOn,
  runTool,
  selectText,
} from './project'
import {
  clearScreenshots,
  SCREENSHOT_DIR,
  type ScreenId,
  screenshotName,
  type ScreenTheme,
  type ScreenViewport,
  THEMES,
  VIEWPORTS,
  writeScreenshotIndex,
} from './screens'

/**
 * Captures d'écran de l'application (projet Playwright `screenshots`,
 * `pnpm --filter @kaxolax/web screenshots`) : un projet de démonstration réaliste est semé une
 * fois (fichiers, image, bibliographie, deux collaboratrices, commentaires, messages, versions,
 * lien de partage, invitation), puis chaque écran est capturé en pleine page, en thème sombre et
 * clair, en 1440×900 et 390×844. Fichiers PNG aux noms stables dans `e2e/screenshots/` (ignoré
 * par git, vidé au début de chaque passage) et index `index.md`. Toutes les variantes sont les
 * étapes d'un seul test : un écran ou une variante qui échoue n'empêche pas les suivants, et la
 * liste des échecs fait échouer le parcours à la fin.
 */

const BANNER_PREFIX = 'Captures'
/** Bannière active de l'écran `04-banner` (supprimée aussitôt la capture prise). */
const BANNER_MESSAGE = `${BANNER_PREFIX} : maintenance ce soir de 22 h à 23 h, enregistrez votre travail.`
/** Durée maximale d'une variante (une taille et un thème). */
const VARIANT_TIMEOUT_MS = 600_000
/** Mot mal orthographié de la démonstration (menu du correcteur). */
const MISSPELLED = 'dimenssions'
const VERSION_LABEL = 'Version soumise'
const TOOL_MENUS = [
  ['file', '06-tools-file'],
  ['format', '06-tools-format'],
  ['structures', '06-tools-structures'],
  ['math', '06-tools-math'],
  ['graphics', '06-tools-graphics'],
  ['packages', '06-tools-packages'],
  ['search', '06-tools-search'],
  ['replace', '06-tools-replace'],
] as const satisfies readonly (readonly [string, ScreenId])[]

interface Demo {
  accounts: Accounts
  owner: Account
  collaborator: Account
  admin: Account
  projectId: string
  /** Lien de partage en lecture seule (page `/share/<jeton>`). */
  shareUrl: string
  /** Page de l'invitation en attente (`/invitations/<jeton>`), null sans Mailpit. */
  invitation: string | null
  /** Session de l'admin dans l'application admin (bannière active), ouverte à la demande. */
  adminPage: Page | null
}

let demo: Demo | null = null

function seeded(): Demo {
  if (demo === null) throw new Error('the demo project was not seeded')
  return demo
}

/** Contexte d'une capture : taille, densité, écran tactile et thème du système. */
function contextFor(viewport: ScreenViewport, theme: ScreenTheme): BrowserContextOptions {
  return {
    viewport: { width: viewport.width, height: viewport.height },
    deviceScaleFactor: viewport.mobile ? 2 : 1,
    isMobile: viewport.mobile,
    hasTouch: viewport.mobile,
    colorScheme: theme,
  }
}

/**
 * Projet de démonstration : importé par Ada (correcteur en français), Grace éditrice, trois
 * compilations (versions), modifications des deux autrices (dont un mot mal orthographié pour le
 * menu du correcteur), un label, trois fils de commentaires (dont un résolu), une conversation
 * dans le chat, un lien de partage en lecture seule et une invitation en attente. Grace reste
 * connectée sur main.tex (présence) ; la barre Tools d'Ada est refermée.
 */
async function seedDemo(accounts: Accounts): Promise<Demo> {
  const owner = await accounts.create(PEOPLE.ada)
  const collaborator = await accounts.create(PEOPLE.grace)
  const admin = await accounts.create({
    ...PEOPLE.katherine,
    totp: true,
    admin: true,
    signedOut: true,
  })
  const projectId = await importProject(owner.page, DEMO_NAME, demoProjectFiles())
  await api(owner.page, 'PATCH', `/projects/${projectId}`, { spellcheckLanguage: 'fr' })
  await addMember(owner, collaborator, projectId, 'editor')
  expect((await compile(owner.page)).status).toBe('success')

  // Modifications des deux autrices, puis une compilation : version au diff à deux couleurs.
  await openProject(collaborator.page, projectId)
  await openInTree(collaborator.page, 'sections/methode.tex')
  await appendToEditor(
    collaborator.page,
    'La température a été relevée toutes les dix secondes par trois thermocouples.\n',
  )
  await placeCursorAfter(owner.page, 'près~\\cite{knuth}.')
  await owner.page.keyboard.insertText(
    `\nUne étude en deux ${MISSPELLED} fera l’objet d’un prochain article.`,
  )
  expect((await compile(owner.page)).status).toBe('success')
  const { versions } = await api<{ versions: { id: string }[] }>(
    owner.page,
    'GET',
    `/projects/${projectId}/versions`,
  )
  const latest = versions[0]
  if (latest === undefined) throw new Error('no version after the compilations')
  await api(owner.page, 'PATCH', `/projects/${projectId}/versions/${latest.id}`, {
    label: VERSION_LABEL,
  })

  // Commentaires : un fil avec réponse, un fil de Grace, un fil résolu.
  await openInTree(collaborator.page, 'main.tex')
  const question = 'Préciser l’intervalle de confiance ?'
  await selectText(owner.page, 'Le modèle reproduit les mesures à moins de 5~\\% près')
  await commentSelection(owner.page, question)
  await openReview(collaborator.page)
  const thread = commentThread(collaborator.page, question)
  await thread.click()
  await thread.getByTestId('comment-input').fill('Ajouté dans la section Résultats.')
  await thread.getByTestId('comment-submit').click()
  await expect(thread.getByTestId('comment')).toHaveCount(2)
  await selectText(collaborator.page, 'Conductivités et écart à la solution analytique.')
  await commentSelection(collaborator.page, 'Ajouter l’incertitude de mesure.')
  await selectText(owner.page, 'Propagation de la chaleur dans une barre métallique')
  const title = await commentSelection(owner.page, 'Titre validé.')
  await title.getByTestId('comment-resolve').click()
  await owner.page.getByTestId('review-toggle').click()
  await collaborator.page.getByTestId('review-toggle').click()

  // Chat : conversation avec une mention et une référence de fichier.
  const say = (account: Account, body: string) =>
    api(account.page, 'POST', `/projects/${projectId}/chat/messages`, { body })
  await say(owner, 'Bonjour Grace, j’ai terminé la section Résultats.')
  await say(collaborator, 'Merci ! Je relis main.tex:26 et la figure.')
  await say(owner, `<@${collaborator.id}> peux-tu vérifier le tableau des conductivités ?`)
  await say(collaborator, 'C’est fait, les valeurs sont à jour.')

  // Partage : lien en lecture seule actif et invitation en attente (pages pour rejoindre).
  const shareUrl = await enableShareLink(owner.page, projectId, 'view')
  const invitee = testEmail('invitee')
  await invite(owner, projectId, invitee)
  const invitation = (await mailpitAvailable()) ? await invitationPath(invitee) : null

  expect((await compile(owner.page)).status).toBe('success')
  // Grace reste sur main.tex, curseur sur une ligne visible : présence pour les captures.
  await placeCursorOn(collaborator.page, 'La figure~\\ref{fig:courbe}')
  // Les outils de la préparation (recherche) ont ouvert la barre Tools, préférence du compte :
  // refermée, toutes les variantes de 04-project sont prises sans elle.
  await hideTools(owner.page)
  return {
    accounts,
    owner,
    collaborator,
    admin,
    projectId,
    shareUrl,
    invitation,
    adminPage: null,
  }
}

/**
 * Invitation en attente de `email` (relecteur) sur le projet de démonstration ; si le plan du
 * compte y refuse un collaborateur de plus (Free : Grace atteint déjà la limite, écran
 * `10-plan-limit`), sur un second projet d'Ada, vide.
 */
async function invite(owner: Account, projectId: string, email: string): Promise<void> {
  const body = { email, role: 'reviewer' }
  try {
    await api(owner.page, 'POST', `/projects/${projectId}/invitations`, body)
  } catch (error) {
    if (!(error instanceof ApiCallError) || error.code !== 'E_PLAN_LIMIT') throw error
    const { project } = await api<{ project: { id: string } }>(owner.page, 'POST', '/projects', {
      name: 'Rapport de stage',
    })
    await api(owner.page, 'POST', `/projects/${project.id}/invitations`, body)
  }
}

/** Session de l'admin (MFA), ouverte à la première bannière et gardée pour les suivantes. */
async function adminSession(): Promise<Page> {
  const current = seeded()
  if (current.adminPage === null) {
    const page = await current.accounts.blankPage()
    await signInAdmin(page, current.admin.user)
    current.adminPage = page
  }
  return current.adminPage
}

test.beforeAll(async ({ browser }, testInfo) => {
  testInfo.setTimeout(600_000)
  await clearScreenshots()
  const accounts = new Accounts(browser, {
    baseURL: testInfo.project.use.baseURL,
    locale: 'fr-FR',
    timezoneId: 'Europe/Paris',
    viewport: { width: 1440, height: 900 },
    acceptDownloads: true,
  })
  try {
    demo = await seedDemo(accounts)
  } catch (error) {
    await accounts.dispose()
    throw error
  }
})

test.afterAll(async () => {
  // Aucune bannière de capture laissée active (elle recouvrirait l'application).
  if (demo?.adminPage) {
    await deleteBanners(demo.adminPage, BANNER_PREFIX).catch((error: unknown) => {
      console.warn('could not delete the screenshot banners', error)
    })
  }
  await demo?.accounts.dispose()
  demo = null
  await writeScreenshotIndex()
})

/**
 * Prise des captures d'une session : chaque écran est préparé puis capturé ; un échec est noté
 * (liste commune à toutes les variantes), la page remise en état, et l'écran suivant capturé
 * quand même. Un écran sans objet ici (service absent) est sauté, avec la raison.
 */
class Shots {
  constructor(
    private readonly page: Page,
    private readonly theme: ScreenTheme,
    private readonly viewport: ScreenViewport,
    private readonly failures: string[],
  ) {}

  private get variant(): string {
    return `${this.theme}, ${this.viewport.name}`
  }

  /** Écran non capturé dans cette configuration (raison dans le rapport du test). */
  skip(id: ScreenId, reason: string): void {
    test.info().annotations.push({
      type: 'skipped screen',
      description: `${id} (${this.variant}): ${reason}`,
    })
  }

  async take(id: ScreenId, prepare: () => Promise<void>): Promise<void> {
    try {
      await test.step(id, async () => {
        await prepare()
        await this.page.evaluate(() => document.fonts.ready.then(() => undefined))
        await this.page.screenshot({
          path: join(SCREENSHOT_DIR, screenshotName(id, this.theme, this.viewport.name)),
          fullPage: true,
          animations: 'disabled',
          caret: 'hide',
          // Indicateur de `next dev`, absent en production.
          style: 'nextjs-portal { display: none !important; }',
        })
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.failures.push(`${id} (${this.variant}): ${message.split('\n')[0] ?? ''}`)
      await this.reset()
    }
  }

  /** Après un échec : fenêtres fermées, page rechargée. */
  private async reset(): Promise<void> {
    try {
      await this.page.keyboard.press('Escape')
      await this.page.keyboard.press('Escape')
      await this.page.reload()
    } catch {
      // Page fermée ou bloquée : les écrans suivants échoueront à leur tour, et seront listés.
    }
  }
}

/** Page projet ouverte sur le document principal. */
async function onProject(page: Page, projectId: string): Promise<void> {
  if (!page.url().endsWith(`/project/${projectId}`)) await openProject(page, projectId)
  await expect(page.locator('[data-testid="editor-tab"][aria-selected="true"]')).toHaveAttribute(
    'data-tab-path',
    'main.tex',
  )
}

/** Écran étroit : tiroir de la sidebar ouvert (sans effet sur grand écran). */
async function showSidebar(page: Page): Promise<void> {
  const open = page.getByRole('button', { name: /^Ouvrir la barre latérale/ })
  if (await open.isVisible()) await open.click()
  await expect(page.getByRole('complementary', { name: 'Barre latérale' })).toBeVisible()
}

async function hideSidebar(page: Page): Promise<void> {
  const close = page.getByRole('button', { name: 'Fermer la barre latérale' })
  if (await close.isVisible()) await close.click()
}

/** Écran étroit : vue Éditeur ou PDF (les deux sont visibles sur grand écran). */
async function showView(page: Page, view: 'editor' | 'pdf'): Promise<void> {
  const tab = page.getByTestId(`view-${view}`)
  if (await tab.isVisible()) await tab.click()
}

/** Remise en état après une capture ; sans effet si la capture a échoué (page rechargée). */
async function tidy(action: () => Promise<unknown>): Promise<void> {
  try {
    await action()
  } catch {
    // La page a déjà été remise en état par `Shots.take`.
  }
}

async function closeDialog(page: Page): Promise<void> {
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog')).toHaveCount(0)
}

/** Barre Tools refermée (préférence de l'utilisateur) pour les écrans suivants. */
async function hideTools(page: Page): Promise<void> {
  if (await page.getByTestId('tools-bar').isVisible())
    await page.getByTestId('tools-toggle').click()
}

/** Pages de connexion et d'inscription (composants Clerk), dans une session déconnectée. */
async function captureSignedOut(shots: Shots, page: Page): Promise<void> {
  await shots.take('00-sign-in', async () => {
    await page.goto('/sign-in')
    await expect(page.locator('.cl-signIn-root')).toBeVisible()
    await expect(page.locator('input[name="identifier"]')).toBeVisible()
  })
  await shots.take('00-sign-up', async () => {
    await page.goto('/sign-up')
    await expect(page.locator('.cl-signUp-root')).toBeVisible()
    await expect(page.locator('.cl-formButtonPrimary')).toBeVisible()
  })
}

/** Écrans publics, tableau de bord, compte et tarifs. */
async function captureOutside(shots: Shots, page: Page, viewport: ScreenViewport): Promise<void> {
  await shots.take('01-dashboard', async () => {
    await page.goto('/dashboard')
    await expect(page.getByTestId('project-row').first()).toBeVisible()
  })
  await shots.take('01-new-from-template', async () => {
    await page.goto('/dashboard')
    await expect(page.getByTestId('project-row').first()).toBeVisible()
    // Barre latérale du tableau de bord sur grand écran, bouton « Template » sur écran étroit.
    await (
      viewport.mobile
        ? page.getByRole('button', { name: 'Template', exact: true })
        : page.getByTestId('new-from-template')
    ).click()
    const picker = page.getByTestId('template-picker')
    await expect(
      picker.getByRole('heading', { name: 'Nouveau projet depuis un template' }),
    ).toBeVisible()
    await expect(picker.getByTestId('template-card').first()).toBeVisible()
  })
  await tidy(() => closeDialog(page))
  await shots.take('02-templates', async () => {
    await page.goto('/templates')
    await expect(page.getByTestId('template-card').first()).toBeVisible()
  })
  await shots.take('03-template-detail', async () => {
    await page.getByTestId('template-card').first().click()
    await expect(page).toHaveURL(/\/templates\/[^/]+$/)
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
  })
  await shots.take('21-pricing', async () => {
    await page.goto('/pricing')
    await expect(
      page.getByRole('heading', { level: 1, name: 'Choisissez votre plan' }),
    ).toBeVisible()
    // Table des plans de Clerk Billing (absente si Billing n'est pas activé sur l'instance).
    await page
      .locator('.cl-pricingTable-root')
      .waitFor({ timeout: 10_000 })
      .catch(() => undefined)
  })
  await shots.take('22-account', async () => {
    await page.goto('/account')
    await expect(page.locator('.cl-userProfile-root')).toBeVisible()
  })
  // Onglet Billing de Clerk, présent seulement si Billing est activé pour les utilisateurs.
  const billing = page.locator('.cl-navbarButton__billing').filter({ visible: true })
  if ((await billing.count().catch(() => 0)) === 0) {
    shots.skip('22-account-billing', 'Clerk Billing n’est pas activé sur l’instance')
  } else {
    await shots.take('22-account-billing', async () => {
      await billing.first().click()
      await expect(page).toHaveURL(/\/account\/billing/)
      await expect(page.locator('.cl-profilePage__billing')).toBeVisible()
    })
  }
  const { shareUrl, invitation } = seeded()
  await shots.take('10-join-link', async () => {
    await page.goto(new URL(shareUrl).pathname)
    await expect(page.getByTestId('join-card')).toContainText(`« ${DEMO_NAME} »`)
  })
  if (invitation === null) {
    shots.skip('10-join-invitation', 'Mailpit (pile locale) absent : lien d’invitation inconnu')
  } else {
    await shots.take('10-join-invitation', async () => {
      await page.goto(invitation)
      await expect(page.getByTestId('join-card')).toContainText('comme relecteur')
    })
  }
}

/** Page projet : éditeur, PDF, barre Tools et ses menus. */
async function captureProject(shots: Shots, page: Page, viewport: ScreenViewport) {
  const { projectId } = seeded()
  await tidy(() => hideTools(page))
  await shots.take('04-project', async () => {
    await onProject(page, projectId)
    if (!viewport.mobile) await expectPdfText(page, 'Introduction', 'Conclusion')
  })
  await shots.take('04-banner', async () => {
    await onProject(page, projectId)
    const admin = await adminSession()
    await api(admin, 'POST', '/admin/banners', { message: BANNER_MESSAGE, level: 'maintenance' })
    // Reçue en direct (temps réel) ou au relevé suivant.
    await expect(page.getByRole('region', { name: 'Annonces' })).toContainText(BANNER_MESSAGE, {
      timeout: 60_000,
    })
  })
  // Bannière supprimée par l'admin dès la capture prise (réussie ou non).
  await tidy(async () => {
    await deleteBanners(await adminSession(), BANNER_PREFIX)
    await expect(page.getByText(BANNER_MESSAGE)).toHaveCount(0, { timeout: 60_000 })
  })
  await shots.take('04-compile-menu', async () => {
    await onProject(page, projectId)
    await showView(page, 'pdf')
    await page.getByTestId('compile-menu').click()
    await expect(
      page.getByRole('menuitemcheckbox', { name: 'Compilation automatique' }),
    ).toBeVisible()
  })
  await tidy(() => page.keyboard.press('Escape'))
  await shots.take('04-pdf-zoom', async () => {
    await onProject(page, projectId)
    await showView(page, 'pdf')
    await page
      .getByRole('region', { name: 'Aperçu PDF', exact: true })
      .getByRole('button', { name: 'Zoom', exact: true })
      .click()
    await expect(page.getByRole('menuitemradio', { name: '400 %' })).toBeVisible()
  })
  await tidy(() => page.keyboard.press('Escape'))
  await shots.take('04-pdf-more', async () => {
    await onProject(page, projectId)
    await showView(page, 'pdf')
    await page.getByTestId('pdf-more-menu').click()
    await page.getByRole('menuitem', { name: 'Fichiers de sortie' }).hover()
    await expect(page.getByTestId('output-output.log')).toBeVisible()
  })
  await tidy(async () => {
    await page.keyboard.press('Escape')
    await page.keyboard.press('Escape')
  })
  await tidy(() => showView(page, 'editor'))
  if (viewport.mobile) {
    await shots.take('05-project-pdf', async () => {
      await onProject(page, projectId)
      await showView(page, 'pdf')
      await expectPdfText(page, 'Introduction')
    })
    await tidy(() => showView(page, 'editor'))
  }
  for (const [menu, id] of TOOL_MENUS) {
    await shots.take(id, async () => {
      await onProject(page, projectId)
      const bar = page.getByTestId('tools-bar')
      if (!(await bar.isVisible())) await page.getByTestId('tools-toggle').click()
      await bar.locator(`[data-menu="${menu}"]`).click()
      await expect(page.getByRole('menu')).toBeVisible()
    })
    await tidy(() => page.keyboard.press('Escape'))
  }
  await tidy(() => hideTools(page))
}

/** Sidebar et panneaux : plan, recherche, logs, partage, présence, chat, Review, historique. */
async function capturePanels(shots: Shots, page: Page, viewport: ScreenViewport) {
  const { projectId } = seeded()
  await shots.take('07-outline', async () => {
    await onProject(page, projectId)
    await showSidebar(page)
    await expect(page.getByTestId('outline')).toContainText('Résultats')
  })
  await tidy(() => hideSidebar(page))
  await shots.take('08-search', async () => {
    await onProject(page, projectId)
    await showSidebar(page)
    await page.getByTestId('project-search-button').click()
    await page.getByTestId('project-search-input').fill('chaleur')
    await expect(page.getByTestId('search-match').first()).toBeVisible()
  })
  await tidy(() => page.getByRole('button', { name: 'Fermer la recherche' }).click())
  await tidy(() => hideSidebar(page))
  await shots.take('09-logs', async () => {
    await onProject(page, projectId)
    await showView(page, 'pdf')
    await page.getByTestId('panel-logs').click()
    await expect(page.getByTestId('compile-status')).toBeVisible()
  })
  await tidy(async () => {
    if (await page.getByTestId('close-logs').isVisible())
      await page.getByTestId('close-logs').click()
  })
  await tidy(() => showView(page, 'editor'))
  await shots.take('10-share', async () => {
    await onProject(page, projectId)
    await showSidebar(page)
    await page.getByTestId('share-button').click()
    await expect(page.getByTestId('member-row')).toHaveCount(2)
  })
  await tidy(() => closeDialog(page))
  await tidy(() => hideSidebar(page))
  await capturePlanLimit(shots, page)
  await shots.take('11-presence', async () => {
    await onProject(page, projectId)
    await expect(page.locator('.cm-content .cm-ySelectionCaret')).toHaveCount(1)
    await showSidebar(page)
    const avatar = page.getByTestId('presence-stack').getByRole('button').first()
    await expect(avatar).toBeVisible()
    if (!viewport.mobile) await avatar.hover()
  })
  await tidy(() => hideSidebar(page))
  await shots.take('12-chat', async () => {
    await onProject(page, projectId)
    await showSidebar(page)
    await page.getByRole('tab', { name: /^Chats/ }).click()
    await expect(page.getByTestId('chat-message')).toHaveCount(4)
  })
  await tidy(() => page.getByRole('tab', { name: 'Fichiers', exact: true }).click())
  await tidy(() => hideSidebar(page))
  await shots.take('13-review', async () => {
    await onProject(page, projectId)
    await openReview(page)
    await expect(page.getByTestId('comment-thread')).toHaveCount(2)
    await page.getByTestId('comment-thread').first().click()
  })
  await tidy(async () => {
    if (await page.getByTestId('review-panel').isVisible()) {
      await page.getByTestId('review-toggle').click()
    }
  })
  await shots.take('14-history-list', async () => {
    await onProject(page, projectId)
    await page.getByTestId('history-button').click()
    await expect(
      page.getByTestId('history-version').filter({ hasText: VERSION_LABEL }),
    ).toBeVisible()
  })
  await shots.take('14-history-diff', async () => {
    await onProject(page, projectId)
    if (!(await page.getByTestId('history-drawer').isVisible())) {
      await page.getByTestId('history-button').click()
    }
    await page.getByTestId('history-version').filter({ hasText: VERSION_LABEL }).click()
    await expect(page.getByTestId('history-diff')).toBeVisible()
  })
  await tidy(() => page.keyboard.press('Escape'))
}

/**
 * Limite de collaborateurs du plan atteinte (modale de partage, invitation refusée avec le lien
 * vers les tarifs) ; sautée si le plan du compte n'a pas de limite ou si le projet de
 * démonstration ne l'atteint pas.
 */
async function capturePlanLimit(shots: Shots, page: Page): Promise<void> {
  const { projectId } = seeded()
  const { collaborators } = await api<{
    collaborators: { max: number | null; used: number } | null
  }>(page, 'GET', `/projects/${projectId}/members`).catch(() => ({ collaborators: null }))
  const max = collaborators?.max ?? null
  if (max === null || (collaborators?.used ?? 0) < max) {
    shots.skip('10-plan-limit', 'limite de collaborateurs absente ou non atteinte par la démo')
    return
  }
  await shots.take('10-plan-limit', async () => {
    await onProject(page, projectId)
    await showSidebar(page)
    await page.getByTestId('share-button').click()
    const dialog = page.getByTestId('share-dialog')
    await expect(dialog.getByTestId('collaborator-usage')).toContainText('limite atteinte')
    await dialog.getByTestId('invite-email').fill(testEmail('limite'))
    await dialog.getByTestId('invite-submit').click()
    const notice = dialog.getByTestId('plan-limit-notice')
    await expect(notice).toHaveAttribute('data-limit', 'collaborators')
    await expect(notice.getByRole('link', { name: 'Voir les plans' })).toBeVisible()
  })
  await tidy(() => closeDialog(page))
  await tidy(() => hideSidebar(page))
}

/** Boîtes de dialogue des outils, ouvertes sans rien insérer. */
async function captureDialogs(shots: Shots, page: Page) {
  const { projectId } = seeded()
  await shots.take('15-formula', async () => {
    await onProject(page, projectId)
    await placeCursorOn(page, 'La figure~\\ref{fig:courbe}')
    await runTool(page, 'math', 'math.formula')
    const dialog = page.getByRole('dialog', { name: 'Éditeur de formules' })
    await expect(dialog.locator('math-field')).toBeVisible()
    await dialog.getByLabel('LaTeX', { exact: true }).fill('\\int_0^1 x^2\\,dx = \\frac{1}{3}')
  })
  await tidy(() => closeDialog(page))
  await shots.take('16-symbols', async () => {
    await runTool(page, 'math', 'math.symbols')
    await expect(page.getByRole('listbox', { name: 'Symboles' })).toBeVisible()
  })
  await tidy(() => closeDialog(page))
  await shots.take('17-table', async () => {
    await runTool(page, 'structures', 'structures.table')
    const dialog = page.getByRole('dialog', { name: 'Nouveau tableau' })
    const cells = { A1: 'Matériau', B1: 'Conductivité', A2: 'Cuivre', B2: '401' }
    for (const [cell, value] of Object.entries(cells)) {
      await dialog.getByRole('textbox', { name: `Case ${cell}`, exact: true }).fill(value)
    }
  })
  await tidy(() => page.getByRole('button', { name: 'Annuler', exact: true }).click())
  await shots.take('18-packages', async () => {
    await runTool(page, 'packages', 'packages.manager')
    const dialog = page.getByTestId('package-manager')
    await dialog.getByTestId('package-search').fill('booktabs')
    await dialog.locator('[data-package="booktabs"]').click()
    await expect(dialog.getByTestId('package-add')).toBeVisible()
  })
  await tidy(() => closeDialog(page))
  await tidy(() => hideTools(page))
  await shots.take('19-word-count', async () => {
    await onProject(page, projectId)
    await page.getByTestId('status-word-count').click()
    await expect(page.getByTestId('word-count-total')).toBeVisible({ timeout: 60_000 })
  })
  await tidy(() => closeDialog(page))
  await shots.take('20-settings', async () => {
    await page.getByTestId('status-settings').click()
    await expect(page.getByTestId('settings-font-size')).toBeVisible()
  })
  await tidy(() => closeDialog(page))
  await shots.take('20-spellcheck', async () => {
    await onProject(page, projectId)
    const word = page.locator('.cm-content .cm-spellError', { hasText: MISSPELLED })
    await word.scrollIntoViewIfNeeded()
    await word.click({ button: 'right' })
    await expect(page.getByTestId('spellcheck-menu')).toContainText(`« ${MISSPELLED} »`)
  })
  await tidy(() => page.keyboard.press('Escape'))
}

/** Écrans de l'admin (thème sombre uniquement), avec une bannière programmée dans la liste. */
async function captureAdmin(shots: Shots, page: Page) {
  const { admin, collaborator, projectId } = seeded()
  await signInAdmin(page, admin.user)
  try {
    await shots.take('23-admin-users', async () => {
      await page.goto(adminUrl('/users'))
      await expect(page.getByRole('row').filter({ hasText: '@' }).first()).toBeVisible()
    })
    await shots.take('23-admin-user', async () => {
      await page.goto(adminUrl(`/users/${collaborator.id}`))
      await expect(page.getByRole('main')).toContainText(collaborator.email)
      await expect(page.getByRole('button', { name: 'Bannir', exact: true })).toBeVisible()
    })
    await shots.take('24-admin-projects', async () => {
      await page.goto(adminUrl('/projects'))
      await expect(page.getByRole('row').filter({ hasText: DEMO_NAME }).first()).toBeVisible()
    })
    await shots.take('24-admin-project', async () => {
      await page.goto(adminUrl(`/projects/${projectId}`))
      await expect(page.getByRole('heading', { level: 1, name: DEMO_NAME })).toBeVisible()
      await expect(page.getByRole('button', { name: 'Archiver', exact: true })).toBeVisible()
    })
    await shots.take('25-admin-banners', async () => {
      await page.goto(adminUrl('/banners'))
      await page.getByRole('button', { name: 'Nouvelle bannière' }).click()
      await page
        .getByLabel('Message', { exact: true })
        .fill(`${BANNER_PREFIX} : maintenance programmée samedi de 22 h à 23 h.`)
      await page.getByLabel('Niveau', { exact: true }).selectOption('maintenance')
      // Programmée demain : jamais affichée dans l'application pendant les captures.
      const tomorrow = new Date(Date.now() + 24 * 3600 * 1000)
      const local = new Date(tomorrow.getTime() - tomorrow.getTimezoneOffset() * 60_000)
      await page.getByLabel('Début (vide : maintenant)').fill(local.toISOString().slice(0, 16))
      await page.getByRole('button', { name: 'Publier', exact: true }).click()
      await expect(page.getByText('Bannière créée.', { exact: true })).toBeVisible()
    })
    await shots.take('26-admin-stats', async () => {
      await page.goto(adminUrl('/stats'))
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
      await page.waitForLoadState('networkidle')
    })
    await shots.take('27-admin-audit-log', async () => {
      await page.goto(adminUrl('/audit-log'))
      await expect(
        page.getByRole('row').filter({ hasText: 'Bannière créée' }).first(),
      ).toBeVisible()
    })
  } finally {
    await deleteBanners(page, BANNER_PREFIX).catch((error: unknown) => {
      console.warn('could not delete the screenshot banners', error)
    })
  }
}

/** Écrans de l'application d'une variante (taille et thème), dans une session d'Ada. */
async function captureApplication(
  viewport: ScreenViewport,
  theme: ScreenTheme,
  failures: string[],
): Promise<void> {
  const { accounts, owner } = seeded()
  // Session déconnectée : thème du cookie (aucune préférence de compte à lire).
  const visitor = await accounts.blankPage(contextFor(viewport, theme))
  try {
    await visitor.context().addCookies([{ name: 'kaxolax-theme', value: theme, url: appOrigin() }])
    await captureSignedOut(new Shots(visitor, theme, viewport, failures), visitor)
  } finally {
    await visitor.context().close()
  }
  const page = await accounts.session(owner, contextFor(viewport, theme))
  try {
    await api(page, 'PATCH', '/me/preferences', { theme })
    await page
      .context()
      .addCookies([{ name: 'kaxolax-theme', value: theme, url: new URL(page.url()).origin }])
    const shots = new Shots(page, theme, viewport, failures)
    await captureOutside(shots, page, viewport)
    await captureProject(shots, page, viewport)
    await capturePanels(shots, page, viewport)
    await captureDialogs(shots, page)
  } finally {
    await page.context().close()
  }
}

/** Origine de l'application (projet Playwright `screenshots`). */
function appOrigin(): string {
  const base = test.info().project.use.baseURL
  if (base === undefined) throw new Error('the screenshots project has no baseURL')
  return new URL(base).origin
}

/** Écrans de l'admin d'une taille (thème sombre). */
async function captureAdminVariant(viewport: ScreenViewport, failures: string[]): Promise<void> {
  const { accounts } = seeded()
  const page = await accounts.blankPage(contextFor(viewport, 'dark'))
  try {
    await captureAdmin(new Shots(page, 'dark', viewport, failures), page)
  } finally {
    await page.context().close()
  }
}

/** Variante en échec (session impossible, page fermée…) : notée, les suivantes continuent. */
async function variant(name: string, failures: string[], run: () => Promise<void>) {
  await test.step(name, async () => {
    try {
      await run()
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      failures.push(`${name}: ${message.split('\n')[0] ?? ''}`)
    }
  })
}

test('application and admin screens, every theme and size', async () => {
  test.setTimeout(VARIANT_TIMEOUT_MS * VIEWPORTS.length * (THEMES.length + 1))
  const failures: string[] = []
  for (const viewport of VIEWPORTS) {
    for (const theme of THEMES) {
      await variant(`application screens, ${theme} theme, ${viewport.name}`, failures, () =>
        captureApplication(viewport, theme, failures),
      )
    }
    await variant(`admin screens, dark theme, ${viewport.name}`, failures, () =>
      captureAdminVariant(viewport, failures),
    )
  }
  expect(failures, 'screens that could not be captured').toEqual([])
})
