import type { Page } from '@playwright/test'
import { expect, test } from './accounts'
import { api } from './api'
import { editorText, importProject, projectIdOf, waitForEditor, waitSynced } from './project'

/**
 * Correcteur orthographique (étape 2) : Hunspell dans un Web Worker, langue du projet (fr/en)
 * changée depuis la barre d'état, commandes LaTeX et mathématiques ignorées, menu du clic droit
 * (correction proposée, ajout au dictionnaire personnel gardé après rechargement).
 */
const MAIN = [
  '\\documentclass{article}',
  '\\begin{document}',
  'Ce texte contient un mot ortografié de travers et une erreure.',
  'Les commandes \\textbf{gras} et \\emph{important} sont ignorées, comme $\\alpha + \\beta$.',
  'The house is green.',
  '\\end{document}',
  '',
].join('\n')

/** Mots soulignés par le correcteur dans l'éditeur. */
async function flagged(page: Page): Promise<string[]> {
  return page.locator('.cm-content .cm-spellError').allTextContents()
}

/** Mot souligné de l'éditeur. */
function misspelled(page: Page, word: string) {
  return page.locator('.cm-content .cm-spellError', { hasText: word })
}

/** Change la langue du projet depuis la barre d'état (onglet Projet des paramètres). */
async function chooseLanguage(page: Page, language: 'fr' | 'en'): Promise<void> {
  await page.getByTestId('status-spellcheck').click()
  const dialog = page.getByTestId('settings-dialog')
  const select = dialog.getByTestId('settings-spellcheck-language')
  await expect(select).toBeEnabled()
  const saved = page.waitForResponse(
    (response) =>
      /\/projects\/[0-9a-f-]{36}$/.test(new URL(response.url()).pathname) &&
      response.request().method() === 'PATCH',
  )
  await select.selectOption(language)
  expect((await saved).ok()).toBe(true)
  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()
  await expect(page.getByTestId('status-spellcheck')).toContainText(language.toUpperCase())
}

test('spellchecker: project language, LaTeX ignored, suggestions and personal dictionary', async ({
  accounts,
}) => {
  const { page } = await accounts.create()
  await importProject(page, 'Correcteur', [{ path: 'main.tex', data: MAIN }])
  const projectId = projectIdOf(page)

  await test.step('a new project is checked in English', async () => {
    await expect(page.getByTestId('status-spellcheck')).toContainText('EN')
    await expect.poll(() => flagged(page)).toContain('texte')
    expect(await flagged(page)).not.toContain('house')
  })

  await test.step('in French, misspelled words are underlined, LaTeX is not', async () => {
    await chooseLanguage(page, 'fr')
    await expect.poll(() => flagged(page)).toEqual(expect.arrayContaining(['ortografié', 'house']))
    const words = await flagged(page)
    expect(words).toContain('erreure')
    expect(words).not.toContain('texte')
    for (const ignored of ['textbf', 'emph', 'alpha', 'beta', 'documentclass', 'begin']) {
      expect(words.join(' ')).not.toContain(ignored)
    }
    // Langue enregistrée sur le projet (commune à tous ses membres).
    const { project } = await api<{ project: { spellcheckLanguage: string } }>(
      page,
      'GET',
      `/projects/${projectId}`,
    )
    expect(project.spellcheckLanguage).toBe('fr')
  })

  await test.step('a right click proposes a correction', async () => {
    await misspelled(page, 'erreure').click({ button: 'right' })
    const menu = page.getByTestId('spellcheck-menu')
    await expect(menu).toContainText('« erreure »')
    await menu.getByRole('menuitem', { name: 'erreur', exact: true }).click()
    await expect(menu).toBeHidden()
    await waitSynced(page)
    expect(await editorText(page)).toContain('et une erreur.')
    await expect(misspelled(page, 'erreure')).toHaveCount(0)
  })

  await test.step('a word added to the personal dictionary stays accepted', async () => {
    await misspelled(page, 'ortografié').click({ button: 'right' })
    const menu = page.getByTestId('spellcheck-menu')
    await expect(menu).toContainText('« ortografié »')
    await menu.getByTestId('spellcheck-add').click()
    await expect(misspelled(page, 'ortografié')).toHaveCount(0)
    await expect
      .poll(async () => {
        const { preferences } = await api<{ preferences: { spellcheckDictionary: string[] } }>(
          page,
          'GET',
          '/me/preferences',
        )
        return preferences.spellcheckDictionary
      })
      .toContain('ortografié')

    await page.reload()
    await waitForEditor(page)
    // Vérification refaite après le rechargement (« house » reste souligné en français).
    await expect.poll(() => flagged(page)).toContain('house')
    expect(await flagged(page)).not.toContain('ortografié')
  })

  await test.step('back to English, the French words are underlined instead', async () => {
    await chooseLanguage(page, 'en')
    await expect.poll(() => flagged(page)).toContain('texte')
    expect(await flagged(page)).not.toContain('house')
  })
})
