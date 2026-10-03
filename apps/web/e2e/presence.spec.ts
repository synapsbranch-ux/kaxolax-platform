import { expect, PEOPLE, test } from './accounts'
import { demoProjectFiles } from './demo'
import {
  activeTab,
  addMember,
  importProject,
  openInTree,
  openProject,
  placeCursorOn,
  selectLine,
} from './project'

/**
 * Présence (étape 2) : curseur, sélection et nom du collaborateur dans l'éditeur, pastille du
 * fichier ouvert dans l'arborescence, pile d'avatars, puis suivi d'un collaborateur d'un fichier
 * à l'autre jusqu'à la prochaine frappe.
 */
test('collaborators see each other and one follows the other', async ({ accounts }) => {
  const owner = await accounts.create(PEOPLE.ada)
  const guest = await accounts.create(PEOPLE.grace)
  const projectId = await importProject(owner.page, 'Présence', demoProjectFiles())
  await addMember(owner, guest, projectId, 'editor')
  await openProject(guest.page, projectId)

  await test.step('avatar stack and tree dot show who is online and where', async () => {
    const stack = owner.page.getByTestId('presence-stack')
    await expect(stack).toHaveAttribute('aria-label', /^1 collaborateur en ligne/)
    await expect(stack.getByRole('button', { name: `${guest.name} — Sur main.tex` })).toBeVisible()
    await expect(
      owner.page.locator('[data-path="main.tex"]').getByTestId('tree-presence'),
    ).toHaveAttribute('aria-label', `Ouvert par ${guest.name}`)
  })

  await test.step('the collaborator cursor, selection and name are drawn in the editor', async () => {
    await placeCursorOn(guest.page, '\\section{Résultats}')
    const caret = owner.page.locator('.cm-content .cm-ySelectionCaret')
    await expect(caret).toHaveCount(1)
    await expect(caret.locator('.cm-ySelectionInfo')).toHaveText(guest.name)
    await selectLine(guest.page, 'La figure~\\ref{fig:courbe}')
    await expect(owner.page.locator('.cm-content .cm-ySelection').first()).toBeVisible()
  })

  await test.step('following opens the file of the followed person until the next keystroke', async () => {
    const stack = owner.page.getByTestId('presence-stack')
    await stack.getByRole('button', { name: new RegExp(`^${guest.name} — `) }).click()
    const indicator = owner.page.getByTestId('following-indicator')
    await expect(indicator).toContainText(`Vous suivez ${guest.name}`)

    await openInTree(guest.page, 'sections/methode.tex')
    await expect(activeTab(owner.page)).toHaveAttribute('data-tab-path', 'sections/methode.tex')
    await expect(
      stack.getByRole('button', { name: `${guest.name} — Sur methode.tex` }),
    ).toBeVisible()
    await expect(owner.page.locator('.cm-content .cm-ySelectionCaret')).toHaveCount(1)

    // Une frappe dans l'éditeur arrête le suivi.
    await owner.page.locator('.cm-content').press('ArrowDown')
    await expect(indicator).toBeHidden()
    // La personne change encore de fichier : la page ne la suit plus.
    await openInTree(guest.page, 'main.tex')
    await expect(stack.getByRole('button', { name: `${guest.name} — Sur main.tex` })).toBeVisible()
    await expect(activeTab(owner.page)).toHaveAttribute('data-tab-path', 'sections/methode.tex')
  })
})
