import { join } from 'node:path'
import type { Page } from '@playwright/test'
import { expect, test } from './accounts'
import { editorText, importProject, placeCursorOn, runTool, waitSynced } from './project'
import { SCREENSHOT_DIR } from './screens'

/**
 * Zotero (étape 3, tâche 9) : connexion OAuth 1.0a du compte sur zotero.org, lien du projet à la
 * bibliothèque personnelle, synchronisation vers un `.bib`, puis insertion d'une citation par le
 * sélecteur. Demande un vrai compte Zotero de test (`E2E_ZOTERO_USERNAME`,
 * `E2E_ZOTERO_PASSWORD`, au moins une référence qui contient `E2E_ZOTERO_QUERY`, défaut
 * « the ») et l'API configurée (`ZOTERO_CLIENT_KEY`, `ZOTERO_CLIENT_SECRET`, URL de rappel de
 * l'application OAuth sur cette instance) : sinon le parcours est sauté. Captures : panneau
 * Zotero et sélecteur dans e2e/screenshots/.
 */
const USERNAME = process.env.E2E_ZOTERO_USERNAME ?? ''
const PASSWORD = process.env.E2E_ZOTERO_PASSWORD ?? ''
const QUERY = process.env.E2E_ZOTERO_QUERY ?? 'the'

const MAIN = [
  '\\documentclass{article}',
  '\\usepackage[backend=biber]{biblatex}',
  '\\addbibresource{references.bib}',
  '\\begin{document}',
  'Citation :',
  '\\printbibliography',
  '\\end{document}',
  '',
].join('\n')

/** Autorise Kaxolax sur zotero.org (connexion, puis accord avec les permissions demandées). */
async function authorizeOnZotero(page: Page): Promise<void> {
  await page.waitForURL(/zotero\.org/)
  const username = page.getByLabel(/username/i)
  if (await username.isVisible()) {
    await username.fill(USERNAME)
    await page.getByLabel(/password/i).fill(PASSWORD)
    await page.getByRole('button', { name: /log ?in|sign ?in/i }).click()
  }
  await page
    .getByRole('button', { name: /accept|save key|authorize/i })
    .first()
    .click()
}

test('zotero: connect, link a library, sync the .bib and insert a citation', async ({
  accounts,
}) => {
  test.skip(USERNAME === '' || PASSWORD === '', 'E2E_ZOTERO_USERNAME/PASSWORD absents')
  const { page } = await accounts.create()

  await page.goto('/account/integrations')
  const section = page.getByTestId('zotero-connection')
  await expect(section).toBeVisible()
  test.skip(
    await section.getByText('n’est pas configurée').isVisible(),
    'ZOTERO_CLIENT_KEY/SECRET absents sur cette instance',
  )
  await section.getByRole('button', { name: 'Connecter Zotero' }).click()
  await authorizeOnZotero(page)
  // Retour par la page de rappel, puis sur les intégrations du compte.
  await page.waitForURL(/\/account\/integrations/)
  await expect(page.getByTestId('zotero-connection')).toContainText('Connecté en tant que')

  await importProject(page, 'Zotero', [{ path: 'main.tex', data: MAIN }])
  await runTool(page, 'file', 'file.zotero')
  const panel = page.getByTestId('zotero-panel')
  const form = panel.getByTestId('zotero-link-form')
  await expect(form).toBeVisible()
  await form.getByLabel('Collection').selectOption('')
  await form.getByLabel('Fichier .bib du projet').selectOption('new')
  await form.getByLabel('Nom du nouveau fichier').fill('references.bib')
  await form.getByRole('button', { name: 'Lier et synchroniser' }).click()
  await expect(panel.getByTestId('zotero-status')).toContainText('À jour')
  await expect(panel.getByTestId('zotero-link')).toContainText('references.bib')
  await page.screenshot({ path: join(SCREENSHOT_DIR, 'zotero-panel.png') })

  // Synchro à la demande : rien ne change, l'état reste à jour.
  await panel.getByRole('button', { name: 'Synchroniser' }).click()
  await expect(panel.getByTestId('zotero-status')).toContainText('À jour')
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('file-tree')).toContainText('references.bib')

  // Sélecteur de citations : clé insérée au curseur, entrée présente dans le .bib.
  await placeCursorOn(page, 'Citation :')
  await page.keyboard.press('End')
  await runTool(page, 'structures', 'structures.zotero-cite')
  const picker = page.getByTestId('zotero-citation-picker')
  await picker.getByLabel('Rechercher une référence').fill(QUERY)
  const results = picker.getByTestId('zotero-results')
  await expect(results.getByRole('button', { name: 'Insérer' }).first()).toBeVisible()
  await page.screenshot({ path: join(SCREENSHOT_DIR, 'zotero-citation-picker.png') })
  await results.getByRole('button', { name: 'Insérer' }).first().click()
  await expect(picker).toBeHidden()
  await waitSynced(page)
  expect(await editorText(page)).toMatch(/Citation :\\cite\{[^}]+\}/)
})
