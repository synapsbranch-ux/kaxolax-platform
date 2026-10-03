import { randomUUID } from 'node:crypto'
import { type Account, expect, PEOPLE, test } from './accounts'
import { api, rawApi } from './api'
import { demoProjectFiles } from './demo'
import { importProject, openProject, openShareDialog } from './project'
import { activateTeam, deleteTeam, organizationIdOf, syncTeam, teamPlanActive } from './teams'

/**
 * Workspaces d'équipe (Organisations Clerk) : création d'une équipe par `<CreateOrganization />`,
 * invitation d'un second compte depuis la page de l'équipe (`<OrganizationProfile />`) et
 * acceptation dans le tableau de bord, projet personnel déplacé vers l'équipe, accès du membre
 * (rôle d'équipe), puis retrait du membre par l'administrateur : perte d'accès immédiate. Sans
 * plan d'équipe actif pour l'organisation (abonnement Team souscrit dans le Dashboard Clerk de
 * développement), le déplacement est refusé avec son explication et le parcours de l'accès au
 * projet est sauté.
 *
 * Suppose Organizations activé sur l'instance Clerk de développement (rôles `org:admin`,
 * `org:member`). Sans tunnel, le webhook Clerk n'atteint pas l'API : les pages de l'équipe
 * rattrapent l'organisation active (`POST /workspaces/sync`) ; le retrait est constaté de la même
 * façon depuis la session de l'administrateur.
 */

test('a team: creation, invitation, shared project, removal', async ({ accounts }) => {
  const ada = await accounts.create(PEOPLE.ada)
  const grace = await accounts.create(PEOPLE.grace)
  const teamName = `Équipe e2e ${randomUUID().slice(0, 6)}`
  let organizationId: string | null = null
  try {
    // Création : sélecteur de workspace → « Créer une équipe » → page de la nouvelle équipe.
    await ada.page.goto('/dashboard')
    await ada.page.getByTestId('workspace-switcher').filter({ visible: true }).first().click()
    await ada.page.getByTestId('create-team').click()
    await expect(ada.page).toHaveURL(/\/team\/new/)
    await ada.page.locator('.cl-createOrganization-root input[name="name"]').fill(teamName)
    await ada.page.locator('.cl-createOrganization-root .cl-formButtonPrimary').click()
    await expect(ada.page).toHaveURL(/\/team\/org_[A-Za-z0-9]+/)
    organizationId = organizationIdOf(ada.page)
    // Le workspace apparaît (webhook, ou rattrapage par la page) : Ada est administratrice.
    await expect(ada.page.getByTestId('team-name')).toHaveText(teamName, { timeout: 60_000 })
    await expect(ada.page.getByTestId('team-role')).toHaveText('Vous êtes administrateur')
    await expect(ada.page.getByTestId('team-plan')).toBeVisible()
    await expect(ada.page.locator('.cl-organizationProfile-root')).toBeVisible()

    // Invitation de Grace depuis l'onglet Membres de <OrganizationProfile />.
    await ada.page.locator('.cl-membersPageInviteButton').click()
    const emails = ada.page.locator('.cl-tagInputContainer input')
    await emails.fill(grace.email)
    await emails.press('Enter')
    await ada.page.locator('.cl-organizationProfile-root .cl-formButtonPrimary').click()
    await expect(ada.page.locator('.cl-organizationProfile-root')).toContainText(grace.email)

    // Grace accepte depuis son tableau de bord, puis arrive sur la page de l'équipe.
    await grace.page.goto('/dashboard')
    const invitation = grace.page.getByTestId('team-invitation').filter({ hasText: teamName })
    await expect(invitation).toBeVisible({ timeout: 60_000 })
    await invitation.getByRole('button', { name: 'Rejoindre' }).click()
    await expect(grace.page).toHaveURL(new RegExp(`/team/${organizationId}`))
    await expect(grace.page.getByTestId('team-name')).toHaveText(teamName, { timeout: 60_000 })
    await expect(grace.page.getByTestId('team-role')).toHaveText('Vous êtes membre')

    // Ada déplace un projet personnel vers l'équipe : seulement avec un plan d'équipe actif
    // (abonnement Team de l'organisation de test), sinon le refus est expliqué.
    const active = await teamPlanActive(ada.page, organizationId)
    const projectName = `Article d’équipe ${randomUUID().slice(0, 6)}`
    const projectId = await importProject(ada.page, projectName, demoProjectFiles())
    await ada.page.goto('/dashboard')
    const row = ada.page.getByTestId('project-row').filter({ hasText: projectName })
    await row.getByRole('button', { name: `Actions pour ${projectName}` }).click()
    await ada.page.getByTestId('move-project').click()
    const move = ada.page.getByTestId('move-project-dialog')
    await move.getByTestId('move-project-team').selectOption({ label: teamName })
    await move.getByTestId('move-project-submit').click()
    if (active) {
      await expect(ada.page.getByTestId('dashboard-notice')).toContainText(teamName)
      await expect(row.getByTestId('team-badge')).toContainText(teamName)
    } else {
      await expect(move).toContainText('n’a pas de plan actif')
      await ada.page.keyboard.press('Escape')
      await expect(row.getByTestId('team-badge')).toHaveCount(0)
    }
    await sharedProjectAccess(active, ada, grace, projectId, projectName, teamName)

    // Retrait de Grace dans <OrganizationProfile /> : elle perd l'accès au projet de l'équipe.
    await ada.page.goto(`/team/${organizationId}`)
    const member = ada.page
      .locator('.cl-organizationProfile-root .cl-tableBody tr')
      .filter({ hasText: grace.email })
    await member.locator('.cl-menuButtonEllipsis, .cl-menuButton').first().click()
    await ada.page
      .locator('.cl-menuItem')
      .filter({ hasText: /Supprimer|Retirer|Remove/ })
      .click()
    await expect(member).toHaveCount(0)
    // Sans webhook : rattrapage depuis la session d'Ada (son organisation active).
    await activateTeam(ada.page, organizationId)
    await syncTeam(ada.page, (workspace) => workspace?.memberCount === 1)
    if (active) {
      await expect(
        grace.page.getByText("Vous n'avez plus accès à ce projet", { exact: true }),
      ).toBeVisible({ timeout: 15_000 })
    }
    expect((await rawApi(grace.page, 'GET', `/projects/${projectId}`)).status).toBe(404)
    const { workspaces } = await api<{ workspaces: { clerkOrganizationId: string | null }[] }>(
      grace.page,
      'GET',
      '/workspaces',
    )
    expect(workspaces.map((workspace) => workspace.clerkOrganizationId)).not.toContain(
      organizationId,
    )
  } finally {
    if (organizationId !== null) await deleteTeam(organizationId)
  }
})

/**
 * Projet d'équipe (plan actif seulement) : Grace le voit dans les projets de l'équipe et l'édite
 * (rôle d'équipe : éditeur), puis Ada passe l'accès de l'équipe en lecture (Grace en direct). La
 * page de Grace reste ouverte sur le projet pour constater le retrait.
 */
async function sharedProjectAccess(
  active: boolean,
  ada: Account,
  grace: Account,
  projectId: string,
  projectName: string,
  teamName: string,
): Promise<void> {
  if (!active) return
  // Grace voit le projet dans les projets de l'équipe et l'édite (rôle d'équipe : éditeur).
  await grace.page.getByTestId('team-projects').click()
  await expect(grace.page).toHaveURL(/\/dashboard\?workspace=/)
  await expect(grace.page.getByTestId('team-summary')).toBeVisible()
  const shared = grace.page.getByTestId('project-row').filter({ hasText: projectName })
  await expect(shared).toContainText('Éditeur')
  await openProject(grace.page, projectId)
  const content = grace.page.locator('.cm-content')
  await expect(content).toHaveAttribute('contenteditable', 'true')

  // Ada voit l'accès de l'équipe dans le partage et le passe en lecture : Grace en direct.
  await openProject(ada.page, projectId)
  const dialog = await openShareDialog(ada.page)
  await expect(dialog.getByTestId('team-access')).toContainText(teamName)
  await dialog.getByTestId('team-access-role').selectOption('viewer')
  await expect(dialog.getByTestId('sharing-status')).toContainText('lecteurs')
  await expect(content).toHaveAttribute('contenteditable', 'false')
  await ada.page.keyboard.press('Escape')
}
