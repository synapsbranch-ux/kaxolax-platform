import { setupClerkTestingToken } from '@clerk/testing/playwright'
import { type Account, expect, PEOPLE, test } from './accounts'
import { api, type ApiProject } from './api'
import { deleteTestUserByEmail, fillSignUpForm, testEmail } from './clerk'
import { demoProjectFiles } from './demo'
import { invitationPath, invitationPaths, mailpitAvailable } from './mailpit'
import { addMember, importProject, openProject, openShareDialog, waitForEditor } from './project'

/**
 * Partage (étape 2) : invitation par email avec un rôle (compte existant, ou inscription qui
 * rejoint le projet automatiquement), relance et annulation, liens de partage, changement de
 * rôle en direct, retrait d'un membre, départ d'un membre et transfert de propriété. Chaque
 * parcours crée ses comptes et son projet, supprimés à la fin (fixture `accounts`).
 */

/** Attente maximale avant qu'une invitation puisse être relancée (60 s, marge comprise). */
const RESEND_WAIT_MS = 75_000

/** Rejoint un projet par un lien de partage (page publique `/share/<jeton>`). */
async function joinWithLink(account: Account, url: string, role: string, projectId: string) {
  await account.page.goto(new URL(url).pathname)
  const card = account.page.getByTestId('join-card')
  await expect(card).toContainText(`comme ${role}`)
  await card.getByTestId('join-submit').click()
  await expect(account.page).toHaveURL(new RegExp(`/project/${projectId}$`))
  await waitForEditor(account.page)
}

test('the owner invites by email with a role and the invitee accepts', async ({ accounts }) => {
  test.skip(
    !(await mailpitAvailable()),
    'Mailpit (pile locale) est nécessaire pour lire l’email d’invitation',
  )
  const owner = await accounts.create(PEOPLE.ada)
  const guest = await accounts.create(PEOPLE.grace)
  const projectId = await importProject(owner.page, 'Partage par email', demoProjectFiles())

  const dialog = await openShareDialog(owner.page)
  await dialog.getByTestId('invite-email').fill(guest.email)
  await dialog.getByTestId('invite-role').selectOption('reviewer')
  await dialog.getByTestId('invite-submit').click()
  await expect(dialog.getByTestId('sharing-status')).toHaveText(
    `Invitation envoyée à ${guest.email} (relecteur).`,
  )
  await expect(dialog.getByTestId('invitation-row')).toContainText(guest.email)

  await guest.page.goto(await invitationPath(guest.email))
  const card = guest.page.getByTestId('join-card')
  await expect(card).toContainText('« Partage par email »')
  await expect(card).toContainText('comme relecteur')
  await card.getByTestId('join-submit').click()
  await expect(guest.page).toHaveURL(new RegExp(`/project/${projectId}$`))
  await waitForEditor(guest.page)
  // Relecteur : mode Suggérer imposé (le texte ne change qu'à l'acceptation), et il commente.
  await expect(guest.page.getByTestId('edit-mode-suggest-only')).toBeVisible()
  await expect(guest.page.getByTestId('edit-mode-toggle')).toHaveCount(0)
  await guest.page.getByTestId('review-toggle').click()
  await expect(guest.page.getByTestId('comment-selection')).toBeVisible()

  // La modale ouverte du propriétaire se met à jour sans recharger.
  const member = dialog.getByTestId('member-row').filter({ hasText: guest.name })
  await expect(member.getByTestId('member-role')).toHaveValue('reviewer')
  await expect(dialog.getByTestId('invitation-row')).toHaveCount(0)
})

test('read-only and edit share links, then regeneration', async ({ accounts }) => {
  const owner = await accounts.create(PEOPLE.ada)
  const editor = await accounts.create(PEOPLE.grace)
  const reader = await accounts.create(PEOPLE.alan)
  const projectId = await importProject(owner.page, 'Liens de partage', demoProjectFiles())
  const dialog = await openShareDialog(owner.page)

  const editLink = dialog.getByTestId('share-link-edit')
  await editLink.getByTestId('share-link-toggle').click()
  const editUrl = await editLink.getByTestId('share-link-url').inputValue()
  expect(editUrl).toMatch(/\/share\/[A-Za-z0-9_-]{43}$/)
  await joinWithLink(editor, editUrl, 'éditeur', projectId)
  await expect(editor.page.locator('.cm-content')).toHaveAttribute('contenteditable', 'true')

  const viewLink = dialog.getByTestId('share-link-view')
  await viewLink.getByTestId('share-link-toggle').click()
  const viewUrl = await viewLink.getByTestId('share-link-url').inputValue()
  await joinWithLink(reader, viewUrl, 'lecteur', projectId)
  await expect(reader.page.locator('.cm-content')).toHaveAttribute('contenteditable', 'false')

  // Régénération après confirmation : l'ancien lien d'édition cesse de fonctionner.
  await editLink.getByTestId('share-link-regenerate').click()
  const confirm = owner.page.getByRole('dialog', { name: "Régénérer le lien d'édition ?" })
  await confirm.getByRole('button', { name: 'Régénérer', exact: true }).click()
  await expect(dialog.getByTestId('sharing-status')).toHaveText(
    "Nouveau lien créé : l'ancien ne fonctionne plus.",
  )
  await expect(editLink.getByTestId('share-link-url')).not.toHaveValue(editUrl)
  await reader.page.goto(new URL(editUrl).pathname)
  await expect(reader.page.getByTestId('join-card')).toContainText(
    "Ce lien de partage n'est plus valide : il a été désactivé ou régénéré.",
  )
  await expect(reader.page.getByTestId('join-submit')).toHaveCount(0)
})

test('a role change applies live and a removed member is disconnected within 2 s', async ({
  accounts,
}) => {
  const owner = await accounts.create(PEOPLE.ada)
  const member = await accounts.create(PEOPLE.grace)
  const projectId = await importProject(owner.page, 'Rôles en direct', demoProjectFiles())
  await addMember(owner, member, projectId, 'editor')
  await openProject(member.page, projectId)
  const content = member.page.locator('.cm-content')
  await expect(content).toHaveAttribute('contenteditable', 'true')

  const dialog = await openShareDialog(owner.page)
  await dialog.getByLabel(`Rôle de ${member.name}`).selectOption('viewer')
  await expect(dialog.getByTestId('sharing-status')).toHaveText(
    `${member.name} est maintenant lecteur.`,
  )
  // Sans recharger : lecture seule et message dans la page du membre.
  await expect(content).toHaveAttribute('contenteditable', 'false')
  await expect(
    member.page.getByRole('status').filter({ hasText: 'Votre rôle est maintenant lecteur' }),
  ).toBeVisible()

  await dialog.getByLabel(`Rôle de ${member.name}`).selectOption('editor')
  await expect(content).toHaveAttribute('contenteditable', 'true')

  await dialog.getByRole('button', { name: `Actions pour ${member.name}` }).click()
  await owner.page.getByRole('menuitem', { name: 'Retirer du projet' }).click()
  const confirm = owner.page.getByRole('dialog', { name: `Retirer ${member.name} du projet ?` })
  const removed = member.page.getByText("Vous n'avez plus accès à ce projet", { exact: true })
  await confirm.getByRole('button', { name: 'Retirer', exact: true }).click()
  const removedAt = Date.now()
  await expect(removed).toBeVisible({ timeout: 2_000 })
  expect(Date.now() - removedAt).toBeLessThan(2_000)
  await expect(dialog.getByTestId('member-row').filter({ hasText: member.name })).toHaveCount(0)
  // Retour au tableau de bord quelques secondes plus tard.
  await expect(member.page).toHaveURL(/\/dashboard$/, { timeout: 15_000 })
})

test('the owner transfers the ownership to a member', async ({ accounts }) => {
  const owner = await accounts.create(PEOPLE.ada)
  const member = await accounts.create(PEOPLE.grace)
  const projectId = await importProject(owner.page, 'Transfert', demoProjectFiles())
  await addMember(owner, member, projectId, 'editor')

  const dialog = await openShareDialog(owner.page)
  await dialog.getByRole('button', { name: `Actions pour ${member.name}` }).click()
  await owner.page.getByRole('menuitem', { name: 'Transférer la propriété' }).click()
  const confirm = owner.page.getByRole('dialog', {
    name: `Transférer la propriété à ${member.name} ?`,
  })
  await confirm.getByRole('button', { name: 'Transférer', exact: true }).click()
  await expect(dialog.getByTestId('sharing-status')).toHaveText(
    `${member.name} est maintenant propriétaire du projet.`,
  )
  // L'ancien propriétaire reste membre comme éditeur : vue limitée de la modale.
  await expect(dialog).toContainText('Votre rôle : Éditeur')
  await expect(dialog.getByTestId('invite-form')).toHaveCount(0)

  await openProject(member.page, projectId)
  const memberDialog = await openShareDialog(member.page)
  await expect(memberDialog.getByTestId('invite-form')).toBeVisible()
  await expect(
    memberDialog
      .getByTestId('member-row')
      .filter({ hasText: owner.name })
      .getByTestId('member-role'),
  ).toHaveValue('editor')
})

test('an invitee without an account signs up and joins the project automatically', async ({
  accounts,
}) => {
  test.skip(
    !(await mailpitAvailable()),
    'Mailpit (pile locale) est nécessaire pour lire l’email d’invitation',
  )
  const owner = await accounts.create(PEOPLE.ada)
  const projectId = await importProject(owner.page, 'Invitation et inscription', demoProjectFiles())
  const email = testEmail('nouvelle')
  try {
    const dialog = await openShareDialog(owner.page)
    await dialog.getByTestId('invite-email').fill(email)
    await dialog.getByTestId('invite-role').selectOption('editor')
    await dialog.getByTestId('invite-submit').click()
    await expect(dialog.getByTestId('invitation-row')).toContainText(email)

    const page = await accounts.blankPage()
    await setupClerkTestingToken({ page })
    await page.goto(await invitationPath(email))
    const card = page.getByTestId('join-card')
    await expect(card).toContainText('« Invitation et inscription »')
    await expect(card).toContainText('comme éditeur')
    await card.getByTestId('join-sign-up').click()
    await expect(page).toHaveURL(/\/sign-up/)
    await fillSignUpForm(page, { email, ...PEOPLE.katherine })
    // Retour sur l'invitation, déjà acceptée à la création du compte : le projet s'ouvre seul.
    await expect(page).toHaveURL(new RegExp(`/project/${projectId}$`), { timeout: 60_000 })
    await waitForEditor(page)
    await expect(page.locator('.cm-content')).toHaveAttribute('contenteditable', 'true')
    await expect(dialog.getByTestId('invitation-row')).toHaveCount(0)
    await expect(dialog.getByTestId('member-row')).toHaveCount(2)
  } finally {
    await deleteTestUserByEmail(email)
  }
})

test('the owner resends, then cancels an invitation', async ({ accounts }) => {
  test.setTimeout(300_000)
  const mail = await mailpitAvailable()
  const owner = await accounts.create(PEOPLE.ada)
  await importProject(owner.page, 'Relance', demoProjectFiles())
  const email = testEmail('relance')
  const dialog = await openShareDialog(owner.page)
  await dialog.getByTestId('invite-email').fill(email)
  await dialog.getByTestId('invite-submit').click()
  const row = dialog.getByTestId('invitation-row').filter({ hasText: email })
  await expect(row).toHaveCount(1)
  const visitor = await accounts.blankPage()

  await test.step('a resend sends a new link and invalidates the previous one', async () => {
    const first = mail ? await invitationPath(email) : null
    // Une relance par minute au plus : le bouton se réactive.
    await expect(row.getByTestId('invitation-resend')).toBeEnabled({ timeout: RESEND_WAIT_MS })
    await row.getByTestId('invitation-resend').click()
    await expect(dialog.getByTestId('sharing-status')).toHaveText(`Invitation renvoyée à ${email}.`)
    if (first === null) return
    const [latest] = await invitationPaths(email, 2)
    expect(latest).not.toBe(first)
    await visitor.goto(first)
    await expect(visitor.getByTestId('sharing-error')).toContainText(
      "Cette invitation n'existe plus",
    )
  })

  await test.step('a cancelled invitation disappears and its link stops working', async () => {
    const latest = mail ? await invitationPath(email) : null
    await row.getByTestId('invitation-cancel').click()
    await expect(dialog.getByTestId('sharing-status')).toHaveText(`Invitation de ${email} annulée.`)
    await expect(row).toHaveCount(0)
    if (latest === null) return
    await visitor.goto(latest)
    await expect(visitor.getByTestId('sharing-error')).toContainText(
      "Cette invitation n'existe plus",
    )
    await expect(visitor.getByTestId('join-sign-up')).toHaveCount(0)
  })
})

test('a member leaves the project', async ({ accounts }) => {
  const owner = await accounts.create(PEOPLE.ada)
  const member = await accounts.create(PEOPLE.grace)
  const projectId = await importProject(owner.page, 'Départ', demoProjectFiles())
  await addMember(owner, member, projectId, 'editor')
  await openProject(member.page, projectId)
  const ownerDialog = await openShareDialog(owner.page)
  await expect(ownerDialog.getByTestId('member-row')).toHaveCount(2)

  const dialog = await openShareDialog(member.page)
  // Pas de gestion des membres pour un éditeur, seulement « Quitter ».
  await expect(dialog.getByTestId('invite-form')).toHaveCount(0)
  await dialog.getByTestId('leave-project').click()
  const confirm = member.page.getByRole('dialog', { name: 'Quitter le projet ?' })
  await confirm.getByRole('button', { name: 'Quitter', exact: true }).click()
  await expect(member.page).toHaveURL(/\/dashboard$/, { timeout: 15_000 })
  await expect(member.page.getByTestId('project-row').filter({ hasText: 'Départ' })).toHaveCount(0)
  const { projects } = await api<{ projects: ApiProject[] }>(member.page, 'GET', '/projects')
  expect(projects.map((project) => project.id)).not.toContain(projectId)
  // La modale ouverte du propriétaire se met à jour.
  await expect(ownerDialog.getByTestId('member-row')).toHaveCount(1)
})
