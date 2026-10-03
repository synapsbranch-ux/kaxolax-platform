import { randomUUID } from 'node:crypto'
import { expect, PEOPLE, test } from './accounts'
import { api, type ApiProject, rawApi } from './api'
import {
  adminUrl,
  confirmAdminAction,
  deleteBanners,
  openAdminUser,
  signInAdmin,
  stateBadge,
} from './admin'
import { expectSignInRefused, grantAdminRole, signIn } from './clerk'
import { DEMO_MAIN, demoProjectFiles } from './demo'
import { importProject, projectIdOf } from './project'

/**
 * Admin (étape 2, `apps/admin`) : accès refusé sans le rôle ou sans la MFA, ouvert avec les deux ;
 * recherche d'un utilisateur, bannière visible en direct dans l'application, journal ; bannir
 * (déconnexion immédiate, reconnexion refusée), débannir, révoquer les sessions, supprimer un
 * compte ; projets (recherche, transfert, archivage, corbeille, suppression définitive, sans
 * accès au contenu) ; statistiques. Les comptes admin sont créés avec un secret TOTP et le rôle
 * par l'API Backend de Clerk.
 */
const BANNER_PREFIX = 'Parcours e2e'

test('admin: access control, user search, live banner and audit log', async ({ accounts }) => {
  test.setTimeout(300_000)
  const admin = await accounts.create({ ...PEOPLE.katherine, totp: true, signedOut: true })
  const user = await accounts.create(PEOPLE.edsger)
  await importProject(user.page, 'Bannière en direct', demoProjectFiles())
  const page = admin.page

  await test.step('without the admin role, the admin is refused', async () => {
    await signInAdmin(page, admin.user)
    await expect(page.getByRole('heading', { name: 'Accès refusé' })).toBeVisible()
    await expect(page.getByRole('link', { name: 'Utilisateurs' })).toHaveCount(0)
  })

  await test.step('with the admin role and a verified second factor, it opens', async () => {
    await grantAdminRole(admin.user.clerkId)
    // Le rôle entre dans les claims de la prochaine session : déconnexion, reconnexion avec MFA.
    await page.getByRole('button', { name: 'Se déconnecter' }).click()
    await expect(page).toHaveURL(/\/sign-in/)
    await signInAdmin(page, admin.user)
    await expect(page.getByRole('heading', { level: 1, name: 'Utilisateurs' })).toBeVisible()
  })

  await test.step('an admin finds a user by email', async () => {
    // Liste chargée (page hydratée) avant la saisie.
    await expect(page.getByRole('row').filter({ hasText: '@' }).first()).toBeVisible()
    await page.getByRole('searchbox', { name: 'Email, nom ou id' }).fill(user.email)
    await page.getByRole('button', { name: 'Rechercher' }).click()
    await expect(page).toHaveURL(/\/users\?q=/)
    const row = page.getByRole('row').filter({ hasText: user.email })
    await expect(row).toHaveCount(1)
    await expect(row).toContainText(user.name)
    await row.getByRole('link', { name: user.email }).click()
    await expect(page).toHaveURL(/\/users\/[0-9a-f-]{36}$/)
    await expect(page.getByRole('main')).toContainText(user.email)
  })

  const message = `${BANNER_PREFIX} ${randomUUID().slice(0, 8)} : maintenance à 22 h`
  try {
    await test.step('a new banner shows up live in the application', async () => {
      await page.getByRole('link', { name: 'Bannière système' }).click()
      await page.getByRole('button', { name: 'Nouvelle bannière' }).click()
      await page.getByLabel('Message', { exact: true }).fill(message)
      await page.getByLabel('Niveau', { exact: true }).selectOption('maintenance')
      await page.getByRole('button', { name: 'Publier', exact: true }).click()
      await expect(page.getByText('Bannière créée.', { exact: true })).toBeVisible()
      // Reçue par le temps réel sur la page projet (`banner.changed`), sans attendre le relevé.
      await expect(user.page.getByRole('region', { name: 'Annonces' })).toContainText(message, {
        timeout: 15_000,
      })
    })

    await test.step('the audit log lists the action', async () => {
      await page.getByRole('link', { name: 'Journal' }).click()
      const entry = page.getByRole('row').filter({ hasText: 'Bannière créée' }).first()
      await expect(entry).toContainText(admin.email)
      await expect(entry).toContainText('Réussite')
    })

    await test.step('a deleted banner disappears from the application', async () => {
      await page.getByRole('link', { name: 'Bannière système' }).click()
      const row = page.getByRole('row').filter({ hasText: message })
      await row.getByRole('button', { name: 'Supprimer', exact: true }).click()
      await page
        .getByRole('dialog', { name: 'Supprimer cette bannière ?' })
        .getByRole('button', { name: 'Supprimer', exact: true })
        .click()
      await expect(page.getByText('Bannière supprimée.', { exact: true })).toBeVisible()
      await expect(user.page.getByText(message)).toHaveCount(0, { timeout: 15_000 })
    })
  } finally {
    // Jamais de bannière de parcours laissée en place (elle recouvrirait les autres parcours).
    await deleteBanners(page, BANNER_PREFIX).catch((error: unknown) => {
      console.warn('could not delete the journey banners', error)
    })
  }
})

test('admin: the admin role without a second factor is refused', async ({ accounts }) => {
  const admin = await accounts.create({ ...PEOPLE.alan, admin: true, signedOut: true })
  const page = admin.page
  // Mot de passe seul : la session n'a pas de second facteur vérifié.
  await signIn(page, admin.email, { signInUrl: adminUrl('/sign-in'), landing: /\/users$/ })
  await expect(page.getByRole('heading', { name: 'Accès refusé' })).toBeVisible()
  await expect(page.getByRole('link', { name: 'Utilisateurs' })).toHaveCount(0)
  // L'API refuse aussi : aucune donnée d'admin, même appelée directement.
  const { status } = await rawApi(page, 'GET', '/admin/users?page=1')
  expect([401, 403]).toContain(status)
})

test('admin: ban (immediate sign-out), unban, revoke the sessions, delete the account', async ({
  accounts,
}) => {
  test.setTimeout(360_000)
  const admin = await accounts.create({
    ...PEOPLE.katherine,
    totp: true,
    admin: true,
    signedOut: true,
  })
  const user = await accounts.create(PEOPLE.edsger)
  const projectName = `Compte à bannir ${randomUUID().slice(0, 8)}`
  await importProject(user.page, projectName, demoProjectFiles())
  const page = admin.page
  await signInAdmin(page, admin.user)
  await openAdminUser(page, user.email)

  await test.step('a banned user is signed out at once, realtime included', async () => {
    await confirmAdminAction(page, {
      button: 'Bannir',
      title: 'Bannir ce compte ?',
      confirm: 'Bannir',
    })
    await expect(page.getByRole('alert').filter({ hasText: 'Compte banni' })).toContainText(
      'Compte banni et déconnecté.',
    )
    await expect(stateBadge(page)).toHaveText('Banni')
    // Documents fermés par le service temps réel, sans recharger la page.
    await expect(user.page.getByTestId('sync-state')).not.toHaveText('Enregistré', {
      timeout: 10_000,
    })
    // Session révoquée : la page suivante renvoie à la connexion.
    await user.page.reload()
    await expect(user.page).toHaveURL(/\/sign-in/, { timeout: 60_000 })
  })

  await test.step('a banned user cannot sign in again', async () => {
    await expectSignInRefused(user.page, user.email)
  })

  await test.step('an unbanned user signs in again', async () => {
    await confirmAdminAction(page, {
      button: 'Débannir',
      title: 'Débannir ce compte ?',
      confirm: 'Débannir',
    })
    await expect(page.getByRole('alert').filter({ hasText: 'Compte débanni.' })).toBeVisible()
    await expect(stateBadge(page)).toHaveText('Actif')
    await accounts.signIn(user)
    await expect(
      user.page.getByTestId('project-row').filter({ hasText: projectName }),
    ).toBeVisible()
  })

  await test.step('revoking the sessions signs the user out of every device', async () => {
    await confirmAdminAction(page, {
      button: 'Révoquer les sessions',
      title: 'Révoquer toutes les sessions ?',
      confirm: 'Révoquer',
    })
    await expect(page.getByRole('alert').filter({ hasText: /révoquée/ })).toBeVisible()
    await user.page.reload()
    await expect(user.page).toHaveURL(/\/sign-in/, { timeout: 60_000 })
    // Pas de bannissement : une nouvelle session est possible.
    await accounts.signIn(user)
  })

  await test.step('a deleted account loses its projects', async () => {
    await confirmAdminAction(page, {
      button: 'Supprimer le compte',
      title: 'Supprimer ce compte ?',
      confirm: 'Supprimer le compte',
      typed: user.email,
    })
    await expect(page.getByRole('alert').filter({ hasText: 'Compte supprimé.' })).toBeVisible()
    await expect(stateBadge(page)).toHaveText('Supprimé')
    await page.goto(
      adminUrl(`/projects?${new URLSearchParams({ q: projectName, view: 'all' }).toString()}`),
    )
    await expect(page.getByText('Aucun résultat.', { exact: true })).toBeVisible()
  })

  await test.step('the audit log lists the actions on the account', async () => {
    await openAdminUser(page, user.email)
    await page.getByRole('link', { name: 'Voir le journal' }).click()
    await expect(page).toHaveURL(/\/audit-log\?/)
    // Bannir, débannir, révoquer et supprimer, au nom de l'admin.
    for (const action of [
      'Bannissement',
      'Débannissement',
      'Révocation des sessions',
      'Suppression de compte',
    ]) {
      await expect(
        page.getByRole('row').filter({ hasText: action }).filter({ hasText: admin.email }).first(),
      ).toBeVisible()
    }
  })
})

test('admin: projects are searched, transferred, archived, trashed, restored and deleted', async ({
  accounts,
}) => {
  test.setTimeout(360_000)
  const admin = await accounts.create({
    ...PEOPLE.katherine,
    totp: true,
    admin: true,
    signedOut: true,
  })
  const owner = await accounts.create(PEOPLE.ada)
  const recipient = await accounts.create(PEOPLE.grace)
  const projectName = `Projet admin ${randomUUID().slice(0, 8)}`
  await importProject(owner.page, projectName, demoProjectFiles())
  const projectId = projectIdOf(owner.page)
  const page = admin.page
  await signInAdmin(page, admin.user)

  await test.step('a project is found by its name, its owner or its id', async () => {
    await page.getByRole('link', { name: 'Projets' }).click()
    await expect(page.getByRole('heading', { level: 1, name: 'Projets' })).toBeVisible()
    const search = page.getByRole('searchbox', { name: 'Nom, propriétaire ou id' })
    for (const q of [projectName, owner.email, projectId]) {
      await search.fill(q)
      await page.getByRole('button', { name: 'Rechercher' }).click()
      await expect.poll(() => new URL(page.url()).searchParams.get('q')).toBe(q)
      const row = page.getByRole('row').filter({ hasText: projectName })
      await expect(row).toHaveCount(1)
      await expect(row).toContainText(owner.email)
    }
    await page.getByRole('link', { name: projectName }).click()
    await expect(page).toHaveURL(new RegExp(`/projects/${projectId}$`))
  })

  await test.step('the project page shows metadata only, never the content', async () => {
    await expect(page.getByRole('heading', { level: 1, name: projectName })).toBeVisible()
    await expect(page.getByRole('main')).toContainText(`Propriétaire : ${owner.email}`)
    await expect(page.getByRole('main')).toContainText('Taille totale')
    const title = /\\title\{(.+)\}/.exec(DEMO_MAIN)?.[1] ?? ''
    expect(title).not.toBe('')
    await expect(page.getByRole('main')).not.toContainText(title)
  })

  await test.step('the ownership is transferred to another account', async () => {
    await page.getByRole('button', { name: 'Transférer la propriété', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'Transférer la propriété' })
    await dialog.getByRole('searchbox', { name: 'Destinataire' }).fill(recipient.email)
    await dialog
      .getByRole('list', { name: 'Comptes trouvés' })
      .getByRole('button')
      .filter({ hasText: recipient.email })
      .click()
    await dialog.getByRole('button', { name: `Transférer à ${recipient.email}` }).click()
    await expect(dialog).toBeHidden()
    await expect(
      page.getByRole('alert').filter({ hasText: `Propriété transférée à ${recipient.email}.` }),
    ).toBeVisible()
    await expect(page.getByRole('main')).toContainText(`Propriétaire : ${recipient.email}`)
    // L'ancien propriétaire reste éditeur.
    const { projects } = await api<{ projects: ApiProject[] }>(owner.page, 'GET', '/projects')
    expect(projects.find((project) => project.id === projectId)?.role).toBe('editor')
  })

  await test.step('archived, then trashed and restored', async () => {
    await confirmAdminAction(page, {
      button: 'Archiver',
      title: 'Archiver ce projet ?',
      confirm: 'Archiver',
    })
    await expect(page.getByRole('alert').filter({ hasText: 'Projet archivé.' })).toBeVisible()
    await expect(stateBadge(page)).toHaveText('Archivé')
    const archived = await api<{ projects: ApiProject[] }>(
      recipient.page,
      'GET',
      '/projects?view=archived',
    )
    expect(archived.projects.map((project) => project.id)).toContain(projectId)

    await confirmAdminAction(page, {
      button: 'Mettre à la corbeille',
      title: 'Mettre ce projet à la corbeille ?',
      confirm: 'Mettre à la corbeille',
    })
    await expect(
      page.getByRole('alert').filter({ hasText: 'Projet mis à la corbeille.' }),
    ).toBeVisible()
    await expect(stateBadge(page)).toHaveText('Corbeille')

    await confirmAdminAction(page, {
      button: 'Restaurer',
      title: 'Restaurer ce projet ?',
      confirm: 'Restaurer',
    })
    await expect(page.getByRole('alert').filter({ hasText: 'Projet restauré.' })).toBeVisible()
    await expect(stateBadge(page)).toHaveText('Archivé')
  })

  await test.step('a trashed project is deleted for good', async () => {
    await confirmAdminAction(page, {
      button: 'Mettre à la corbeille',
      title: 'Mettre ce projet à la corbeille ?',
      confirm: 'Mettre à la corbeille',
    })
    await confirmAdminAction(page, {
      button: 'Supprimer définitivement',
      title: 'Supprimer définitivement ce projet ?',
      confirm: 'Supprimer définitivement',
      typed: projectName,
    })
    await expect(page).toHaveURL(/\/projects$/)
    await page.goto(
      adminUrl(`/projects?${new URLSearchParams({ q: projectId, view: 'all' }).toString()}`),
    )
    await expect(page.getByText('Aucun résultat.', { exact: true })).toBeVisible()
    const { status } = await rawApi(recipient.page, 'GET', `/projects/${projectId}`)
    expect(status).toBe(404)
  })
})

test('admin: statistics for a chosen period', async ({ accounts }) => {
  const admin = await accounts.create({
    ...PEOPLE.katherine,
    totp: true,
    admin: true,
    signedOut: true,
  })
  const page = admin.page
  await signInAdmin(page, admin.user)
  await page.getByRole('link', { name: 'Statistiques' }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'Statistiques' })).toBeVisible()
  const period = page.getByRole('navigation', { name: 'Période' })
  await expect(period.getByRole('link', { name: '30 j' })).toHaveAttribute('aria-current', 'page')
  await expect(page.getByText('Inscriptions (30 j)', { exact: true })).toBeVisible()
  await expect(page.getByText('Utilisateurs actifs (7 j)', { exact: true })).toBeVisible()
  await expect(page.getByText('Compilations par résultat', { exact: true })).toBeVisible()

  await period.getByRole('link', { name: '7 j' }).click()
  await expect(page).toHaveURL(/\/stats\?days=7$/)
  await expect(page.getByText('Inscriptions (7 j)', { exact: true })).toBeVisible()
  await expect(page.getByText('Compilations (7 j)', { exact: true })).toBeVisible()
})
