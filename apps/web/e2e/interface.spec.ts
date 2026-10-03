import type { Page, Request } from '@playwright/test'
import { expect, PEOPLE, test } from './accounts'
import { api } from './api'
import { DEMO_MAIN, DEMO_NAME, demoProjectFiles } from './demo'
import {
  activeLine,
  activeTab,
  addMember,
  appendToEditor,
  chooseCompiler,
  compile,
  compileStatus,
  editorText,
  expectPdfText,
  importProject,
  openInTree,
  openProject,
  placeCursorOn,
  replaceEditorContent,
  waitForEditor,
  waitSynced,
} from './project'

/**
 * Interface de la page projet (étape 2) : menu de la pastille de compilation (auto-compilation,
 * compilateur, brouillon, arrêt à la première erreur, vider le cache, voir les logs), états de la
 * colonne PDF (jamais compilé, échec avec lien vers les logs), arborescence modifiée par un membre
 * et diffusée aux autres membres connectés, plan du document, recherche dans le
 * projet, colonnes redimensionnables et sidebar repliable mémorisées par utilisateur, bouton
 * Tools, onglets Éditeur et PDF sous 1024 px, onglets ouverts propres à chaque utilisateur,
 * sélecteur de projet, barre et menus du PDF, filtre par workspace.
 */

interface Preferences {
  layout: { sidebarSize: number; editorSize: number; pdfSize: number; sidebarCollapsed: boolean }
  toolsVisible: boolean
  autoCompile: boolean
  compile: { draft: boolean; haltOnFirstError: boolean }
  openTabs: Record<string, { documentIds: string[]; activeDocumentId: string | null }>
}

/** Préférences enregistrées du compte de la page. */
async function preferences(page: Page): Promise<Preferences> {
  return (await api<{ preferences: Preferences }>(page, 'GET', '/me/preferences')).preferences
}

function isCompileRequest(request: Request): boolean {
  return new URL(request.url()).pathname.endsWith('/compile') && request.method() === 'POST'
}

/** Corps d'une demande de compilation (`options`, `trigger`). */
function compileBody(request: Request): {
  options?: { draft?: boolean; haltOnFirstError?: boolean }
  trigger?: string
} {
  return request.postDataJSON() as {
    options?: { draft?: boolean; haltOnFirstError?: boolean }
    trigger?: string
  }
}

/** Coche ou décoche une option du menu de la pastille (le menu se referme au choix). */
async function setCompileOption(page: Page, label: string, checked: boolean): Promise<void> {
  await page.getByTestId('compile-menu').click()
  const item = page.getByRole('menuitemcheckbox', { name: label })
  if ((await item.getAttribute('aria-checked')) === String(checked)) {
    await page.keyboard.press('Escape')
    return
  }
  await item.click()
  await page.getByTestId('compile-menu').click()
  await expect(page.getByRole('menuitemcheckbox', { name: label })).toHaveAttribute(
    'aria-checked',
    String(checked),
  )
  await page.keyboard.press('Escape')
}

/** Ligne (1 à n) de `text` dans `source`. */
function lineOf(source: string, text: string): string {
  const index = source.split('\n').findIndex((line) => line.includes(text))
  if (index < 0) throw new Error(`${text} is not in the source`)
  return String(index + 1)
}

/** Région du PDF (en-tête, visionneuse, barre flottante). */
function pdfRegion(page: Page) {
  return page.getByRole('region', { name: 'Aperçu PDF', exact: true })
}

/** Page affichée dans la barre flottante du PDF (« 2 / 3 »). */
function pdfPosition(page: Page) {
  return page.getByTestId('pdf-page-count').locator('xpath=..')
}

test('compile menu: auto-compilation, compiler, draft mode and halt on first error', async ({
  accounts,
}) => {
  const { page } = await accounts.create()
  await importProject(page, 'Options de compilation', [
    {
      path: 'main.tex',
      data: [
        '\\documentclass{article}',
        '\\begin{document}',
        '\\ifdefined\\XeTeXversion Moteur XeTeX.\\else Moteur pdfTeX.\\fi',
        '\\end{document}',
        '',
      ].join('\n'),
    },
  ])
  expect((await compile(page)).status).toBe('success')
  await expectPdfText(page, 'Moteur pdfTeX.')

  await test.step('the compiler is chosen in the menu and saved on the project', async () => {
    await chooseCompiler(page, 'XeLaTeX')
    expect((await compile(page)).status).toBe('success')
    await expectPdfText(page, 'Moteur XeTeX.')
    await page.getByTestId('compile-menu').click()
    await expect(page.getByRole('menuitemradio', { name: 'XeLaTeX' })).toHaveAttribute(
      'aria-checked',
      'true',
    )
    await page.keyboard.press('Escape')
  })

  await test.step('draft mode and halt on first error are sent with the compilation', async () => {
    await setCompileOption(page, 'Mode brouillon', true)
    await setCompileOption(page, 'Arrêter à la première erreur', true)
    await expect
      .poll(async () => (await preferences(page)).compile)
      .toEqual({ draft: true, haltOnFirstError: true })
    const requested = page.waitForRequest(isCompileRequest)
    expect((await compile(page)).status).toBe('success')
    expect(compileBody(await requested).options).toEqual({ draft: true, haltOnFirstError: true })
    await setCompileOption(page, 'Mode brouillon', false)
    await setCompileOption(page, 'Arrêter à la première erreur', false)
  })

  await test.step('auto-compilation recompiles after a pause in typing', async () => {
    await setCompileOption(page, 'Compilation automatique', true)
    await expect.poll(async () => (await preferences(page)).autoCompile).toBe(true)
    const requested = page.waitForRequest(
      (request) => isCompileRequest(request) && compileBody(request).trigger === 'auto',
      { timeout: 30_000 },
    )
    await appendToEditor(page, 'Ajout compilé automatiquement.\n')
    await requested
    await expect(compileStatus(page)).not.toHaveAttribute('data-status', 'compiling', {
      timeout: 180_000,
    })
    await setCompileOption(page, 'Compilation automatique', false)
    await expect.poll(async () => (await preferences(page)).autoCompile).toBe(false)
  })
})

test('PDF column states, clearing the cache and the logs from the compile menu', async ({
  accounts,
}) => {
  const { page } = await accounts.create()
  // Classe introuvable : erreur fatale, aucun PDF produit.
  await importProject(page, 'États du PDF', [
    {
      path: 'main.tex',
      data: '\\documentclass{classeinexistante}\n\\begin{document}\nTexte.\n\\end{document}\n',
    },
  ])
  const viewer = page.getByTestId('pdf-viewer')
  const drawer = page.getByTestId('log-drawer')

  await test.step('a new project has never been compiled', async () => {
    await expect(compileStatus(page)).toHaveAttribute('data-status', 'never')
    await expect(viewer).toContainText("Ce projet n'a pas encore été compilé.")
    // « Voir les logs » du menu : aucune compilation encore.
    await page.getByTestId('compile-menu').click()
    await page.getByRole('menuitem', { name: 'Voir les logs', exact: true }).click()
    await expect(drawer).toBeVisible()
    await expect(drawer).toContainText("Aucune compilation pour l'instant.")
    await drawer.getByTestId('close-logs').click()
    await expect(drawer).toBeHidden()
  })

  await test.step('a compilation without PDF shows its error and a link to the logs', async () => {
    const failed = await compile(
      page,
      viewer.getByRole('button', { name: 'Compiler', exact: true }),
    )
    expect(failed.status).not.toBe('success')
    expect(failed.pdfUrl).toBeNull()
    await expect(compileStatus(page)).toHaveAttribute('data-status', /^(?:errors|failed)$/)
    await expect(viewer).toContainText('La compilation n’a produit aucun PDF.')
    await viewer.getByRole('button', { name: 'Voir les logs', exact: true }).click()
    await expect(drawer).toBeVisible()
    await expect(drawer.getByTestId('compile-status')).not.toHaveText('Réussie')
    await expect(drawer.getByTestId('log-error').first()).toContainText('classeinexistante')
    await drawer.getByTestId('close-logs').click()
    await expect(drawer).toBeHidden()
  })

  await test.step('the cache is cleared from the menu, the next compilation succeeds', async () => {
    await replaceEditorContent(
      page,
      '\\documentclass{article}\n\\begin{document}\nCompilé après le cache.\n\\end{document}\n',
    )
    expect((await compile(page)).status).toBe('success')
    await page.getByTestId('compile-menu').click()
    const cleared = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname.endsWith('/compile/clear-cache') &&
        response.request().method() === 'POST',
    )
    await page.getByRole('menuitem', { name: 'Vider le cache', exact: true }).click()
    expect((await cleared).ok()).toBe(true)
    // Compilation complète, sans les fichiers intermédiaires de la précédente.
    expect((await compile(page)).status).toBe('success')
    await expectPdfText(page, 'Compilé après le cache.')
    await expect(compileStatus(page)).toHaveAttribute('data-status', 'success')
  })

  await test.step('the logs of the last compilation open from the menu', async () => {
    await page.getByTestId('compile-menu').click()
    await page.getByRole('menuitem', { name: 'Voir les logs', exact: true }).click()
    await expect(drawer).toBeVisible()
    await expect(drawer.getByTestId('compile-status')).toHaveText('Réussie')
    await expect(drawer.getByTestId('log-error')).toHaveCount(0)
    await drawer.getByTestId('close-logs').click()
    await expect(drawer).toBeHidden()
  })
})

/** Ouvre le menu « Actions pour … » d'une ligne de l'arborescence et choisit `action`. */
async function treeAction(page: Page, path: string, action: string): Promise<void> {
  const row = page.locator(`[data-path="${path}"]`)
  const name = path.slice(path.lastIndexOf('/') + 1)
  // Bouton visible au survol de la ligne.
  await row.hover()
  await row.getByRole('button', { name: `Actions pour ${name}`, exact: true }).click()
  await page.getByRole('menuitem', { name: action, exact: true }).click()
}

/** Remplit la boîte de nom (création, renommage) et la valide. */
async function submitName(page: Page, title: string, name: string): Promise<void> {
  const dialog = page.getByRole('dialog', { name: title, exact: true })
  await dialog.locator('#name-dialog-input').fill(name)
  await dialog
    .getByRole('button', { name: title === 'Renommer' ? 'Renommer' : 'Créer', exact: true })
    .click()
  await expect(dialog).toBeHidden()
}

test('file tree changes reach the other connected members without a reload', async ({
  accounts,
}) => {
  const owner = await accounts.create(PEOPLE.ada)
  const member = await accounts.create(PEOPLE.grace)
  const projectId = await importProject(owner.page, 'Arborescence partagée', demoProjectFiles())
  await addMember(owner, member, projectId, 'editor')
  await openProject(member.page, projectId)
  const page = owner.page
  const seen = (path: string) => member.page.locator(`[data-path="${path}"]`)
  // Marque posée dans la page du membre : elle disparaîtrait avec un rechargement.
  await member.page.evaluate(() => Reflect.set(window, 'kaxolaxNoReload', true))

  await test.step('a new folder', async () => {
    await page.getByTestId('sidebar-add').click()
    await page.getByRole('menuitem', { name: 'Nouveau dossier', exact: true }).click()
    await submitName(page, 'Nouveau dossier', 'chapitres')
    await expect(page.locator('[data-path="chapitres"]')).toBeVisible()
    await expect(seen('chapitres')).toBeVisible()
    await expect(seen('chapitres')).toHaveAttribute('data-testid', 'tree-folder')
  })

  await test.step('a new file', async () => {
    await page.getByTestId('sidebar-add').click()
    await page.getByRole('menuitem', { name: 'Nouveau fichier', exact: true }).click()
    await submitName(page, 'Nouveau fichier', 'notes.tex')
    // Le fichier créé s'ouvre chez son auteur.
    await expect(activeTab(page)).toHaveAttribute('data-tab-path', 'notes.tex')
    await expect(seen('notes.tex')).toBeVisible()
  })

  await test.step('a renamed file', async () => {
    await treeAction(page, 'notes.tex', 'Renommer')
    await submitName(page, 'Renommer', 'annexe.tex')
    await expect(page.locator('[data-path="annexe.tex"]')).toBeVisible()
    await expect(seen('annexe.tex')).toBeVisible()
    await expect(seen('notes.tex')).toHaveCount(0)
  })

  await test.step('a file moved into a folder', async () => {
    await page.locator('[data-path="annexe.tex"]').dragTo(page.locator('[data-path="chapitres"]'))
    await expect(page.locator('[data-path="chapitres/annexe.tex"]')).toBeVisible()
    await expect(seen('chapitres/annexe.tex')).toBeVisible()
    await expect(seen('annexe.tex')).toHaveCount(0)
  })

  await test.step('a deleted file', async () => {
    await treeAction(page, 'chapitres/annexe.tex', 'Supprimer')
    const confirm = page.getByRole('dialog', { name: 'Supprimer ?', exact: true })
    await expect(confirm).toContainText('« annexe.tex » sera supprimé.')
    await confirm.getByRole('button', { name: 'Supprimer', exact: true }).click()
    await expect(page.locator('[data-path="chapitres/annexe.tex"]')).toHaveCount(0)
    await expect(seen('chapitres/annexe.tex')).toHaveCount(0)
    await expect(seen('chapitres')).toBeVisible()
  })

  // Toujours la même page chez le membre, et son éditeur toujours synchronisé.
  expect(await member.page.evaluate(() => Reflect.get(window, 'kaxolaxNoReload') === true)).toBe(
    true,
  )
  await waitSynced(member.page)
})

test('outline and project-wide search', async ({ accounts }) => {
  const { page } = await accounts.create()
  await importProject(page, 'Plan et recherche', demoProjectFiles())
  const outline = page.getByTestId('outline')

  await test.step('the outline lists the sections, included files too', async () => {
    for (const title of ['Introduction', 'Méthode', 'Résultats', 'Conclusion']) {
      await expect(outline.getByRole('button', { name: new RegExp(`^${title}`) })).toBeVisible()
    }
  })

  await test.step('the current section is highlighted and a click moves the cursor', async () => {
    await placeCursorOn(page, 'La figure~\\ref{fig:courbe}')
    await expect(outline.locator('[aria-current="location"]')).toHaveText(/^Résultats/)
    await outline.getByRole('button', { name: 'Conclusion', exact: true }).click()
    await expect.poll(() => activeLine(page)).toBe(lineOf(DEMO_MAIN, '\\section{Conclusion}'))
    await expect(outline.locator('[aria-current="location"]')).toHaveText(/^Conclusion/)
  })

  await test.step('the project search opens the file at the match', async () => {
    await page.getByTestId('project-search-button').click()
    await page.getByTestId('project-search-input').fill('diffusivité')
    const match = page.getByTestId('search-match')
    await expect(match).toHaveCount(1)
    await expect(page.getByTestId('search-file')).toContainText('sections/introduction.tex')
    await match.click()
    await expect(activeTab(page)).toHaveAttribute('data-tab-path', 'sections/introduction.tex')
    await expect.poll(() => activeLine(page)).toBe('8')
    await page.getByRole('button', { name: 'Fermer la recherche' }).click()
    await expect(page.getByTestId('project-search')).toHaveCount(0)
  })
})

test('columns, sidebar and Tools button are remembered for each user', async ({ accounts }) => {
  const owner = await accounts.create(PEOPLE.ada)
  const member = await accounts.create(PEOPLE.grace)
  const projectId = await importProject(owner.page, 'Mise en page', demoProjectFiles())
  await addMember(owner, member, projectId, 'editor')
  const page = owner.page
  const editorColumn = page.getByRole('region', { name: 'Éditeur', exact: true })

  await test.step('the editor and PDF columns are resized and the size is kept', async () => {
    const before = (await editorColumn.boundingBox())?.width ?? 0
    const separator = page.locator('[data-separator]').nth(1)
    const box = await separator.boundingBox()
    if (box === null) throw new Error('no separator between the editor and the PDF')
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await page.mouse.down()
    await page.mouse.move(box.x + box.width / 2 + 160, box.y + box.height / 2, { steps: 8 })
    await page.mouse.up()
    const after = (await editorColumn.boundingBox())?.width ?? 0
    expect(after).toBeGreaterThan(before + 100)
    await expect.poll(async () => (await preferences(page)).layout.editorSize).toBeGreaterThan(41)

    await page.reload()
    await waitForEditor(page)
    const reloaded = (await editorColumn.boundingBox())?.width ?? 0
    expect(Math.abs(reloaded - after)).toBeLessThan(4)
  })

  await test.step('the sidebar is collapsed and stays collapsed', async () => {
    await page.getByTestId('sidebar-collapse').click()
    await expect(page.getByTestId('sidebar-expand')).toBeVisible()
    await expect.poll(async () => (await preferences(page)).layout.sidebarCollapsed).toBe(true)
    await page.reload()
    await waitForEditor(page)
    await expect(page.getByTestId('sidebar-expand')).toBeVisible()
  })

  await test.step('the Tools bar stays open after a reload', async () => {
    const toggle = page.getByTestId('tools-toggle')
    await expect(toggle).toHaveAttribute('aria-pressed', 'false')
    await toggle.click()
    await expect(page.getByTestId('tools-bar')).toBeVisible()
    await expect.poll(async () => (await preferences(page)).toolsVisible).toBe(true)
    await page.reload()
    await waitForEditor(page)
    await expect(page.getByTestId('tools-bar')).toBeVisible()
    await expect(toggle).toHaveAttribute('aria-pressed', 'true')
  })

  await test.step('another device of the same user gets the same layout', async () => {
    const other = await accounts.session(owner)
    await openProject(other, projectId)
    await expect(other.getByTestId('sidebar-expand')).toBeVisible()
    await expect(other.getByTestId('tools-bar')).toBeVisible()
  })

  await test.step('another member keeps the default layout', async () => {
    await openProject(member.page, projectId)
    await expect(member.page.getByTestId('sidebar-collapse')).toBeVisible()
    await expect(member.page.getByTestId('sidebar-expand')).toHaveCount(0)
    await expect(member.page.getByTestId('tools-bar')).toHaveCount(0)
  })

  await test.step('the sidebar comes back with the expand button', async () => {
    await page.getByTestId('sidebar-expand').click()
    await expect(
      page.getByRole('complementary', { name: 'Barre latérale', exact: true }),
    ).toBeVisible()
    await expect.poll(async () => (await preferences(page)).layout.sidebarCollapsed).toBe(false)
    await page.getByTestId('tools-toggle').click()
    await expect(page.getByTestId('tools-bar')).toHaveCount(0)
  })
})

test('under 1024 px, the Editor and PDF tabs switch the view', async ({ accounts }) => {
  const account = await accounts.create()
  const projectId = await importProject(account.page, 'Écran étroit', demoProjectFiles())
  expect((await compile(account.page)).status).toBe('success')
  const page = await accounts.session(account, { viewport: { width: 900, height: 800 } })
  await openProject(page, projectId)

  const editorTab = page.getByTestId('view-editor')
  const pdfTab = page.getByTestId('view-pdf')
  await expect(editorTab).toHaveAttribute('aria-selected', 'true')
  await expect(page.locator('.cm-content')).toBeVisible()
  await expect(page.getByTestId('pdf-viewer')).toBeHidden()

  await pdfTab.click()
  await expect(pdfTab).toHaveAttribute('aria-selected', 'true')
  await expect(page.locator('.cm-content')).toBeHidden()
  await expectPdfText(page, 'Introduction')

  await editorTab.click()
  await expect(page.locator('.cm-content')).toBeVisible()
  // La sidebar est un tiroir.
  await page.getByRole('button', { name: /^Ouvrir la barre latérale/ }).click()
  await expect(
    page.getByRole('complementary', { name: 'Barre latérale', exact: true }),
  ).toBeVisible()
  await page.getByRole('button', { name: 'Fermer la barre latérale' }).click()
  await expect(
    page.getByRole('complementary', { name: 'Barre latérale', exact: true }),
  ).toBeHidden()
})

test('open tabs belong to each user', async ({ accounts }) => {
  const owner = await accounts.create(PEOPLE.ada)
  const member = await accounts.create(PEOPLE.grace)
  const projectId = await importProject(owner.page, 'Onglets', demoProjectFiles())
  await addMember(owner, member, projectId, 'editor')
  await openProject(member.page, projectId)

  await openInTree(owner.page, 'sections/methode.tex')
  await openInTree(member.page, 'refs.bib')
  for (const page of [owner.page, member.page]) {
    await expect
      .poll(async () => (await preferences(page)).openTabs[projectId]?.documentIds.length)
      .toBe(2)
  }

  await owner.page.reload()
  await waitForEditor(owner.page)
  await expect(activeTab(owner.page)).toHaveAttribute('data-tab-path', 'sections/methode.tex')
  await expect(owner.page.locator('[data-tab-path="refs.bib"]')).toHaveCount(0)

  await member.page.reload()
  await waitForEditor(member.page)
  await expect(activeTab(member.page)).toHaveAttribute('data-tab-path', 'refs.bib')
  await expect(member.page.locator('[data-tab-path="sections/methode.tex"]')).toHaveCount(0)
})

test('project switcher: recent projects, search, new project, dashboard', async ({ accounts }) => {
  const { page } = await accounts.create()
  const first = await importProject(page, 'Premier projet', demoProjectFiles())
  const second = await importProject(page, 'Second projet', demoProjectFiles())
  const switcher = page.getByRole('button', { name: 'Changer de projet' })
  await expect(page.getByTestId('project-name')).toHaveText('Second projet')

  await test.step('recent projects come first and a search narrows the list', async () => {
    await switcher.click()
    const options = page.getByRole('option')
    await expect(page.getByText('Projets récents', { exact: true })).toBeVisible()
    await expect(options.first()).toHaveText(/Second projet/)
    await expect(options.filter({ hasText: 'Premier projet' })).toHaveCount(1)
    await page.getByRole('combobox', { name: 'Rechercher un projet' }).fill('Premier')
    await expect(options.filter({ hasText: 'Second projet' })).toHaveCount(0)
    await options.filter({ hasText: 'Premier projet' }).click()
    await expect(page).toHaveURL(new RegExp(`/project/${first}$`))
    await waitForEditor(page)
    await expect(page.getByTestId('project-name')).toHaveText('Premier projet')
  })

  await test.step('a new project is created from the switcher', async () => {
    await switcher.click()
    await page.getByRole('option', { name: 'Nouveau projet' }).click()
    const dialog = page.getByRole('dialog', { name: 'Nouveau projet', exact: true })
    await dialog.getByLabel('Nom du projet').fill('Troisième projet')
    await dialog.getByRole('button', { name: 'Créer', exact: true }).click()
    await expect(page).not.toHaveURL(new RegExp(`/project/(${first}|${second})$`))
    await expect(page).toHaveURL(/\/project\/[0-9a-f-]{36}$/)
    await waitForEditor(page)
    await expect(page.getByTestId('project-name')).toHaveText('Troisième projet')
  })

  await test.step('the switcher goes back to the dashboard', async () => {
    await switcher.click()
    await page.getByRole('option', { name: 'Tableau de bord' }).click()
    await expect(page).toHaveURL(/\/dashboard$/)
    await expect(page.getByTestId('project-row')).toHaveCount(3)
  })
})

test('PDF toolbar: zoom, downloads, output files and floating bar', async ({ accounts }) => {
  const { page } = await accounts.create()
  await importProject(page, 'Barre du PDF', [
    {
      path: 'main.tex',
      data: [
        '\\documentclass{article}',
        '\\begin{document}',
        '\\section{Premier}',
        'Texte de la page un.',
        '\\newpage',
        '\\section{Deuxième}',
        'Texte de la page deux.',
        '\\newpage',
        '\\section{Troisième}',
        'Texte de la page trois.',
        '\\end{document}',
        '',
      ].join('\n'),
    },
  ])
  expect((await compile(page)).status).toBe('success')
  await expectPdfText(page, 'Texte de la page un.')
  const pdf = pdfRegion(page)
  await expect(page.getByTestId('pdf-page-count')).toHaveText('3')

  await test.step('zoom from 50 to 400 %, then fit to the width', async () => {
    const zoom = pdf.getByRole('button', { name: 'Zoom', exact: true })
    for (const level of ['50 %', '200 %', '400 %']) {
      await zoom.click()
      await page.getByRole('menuitemradio', { name: level, exact: true }).click()
      await expect(page.getByTestId('zoom-level')).toHaveText(level)
    }
    await zoom.click()
    await page.getByRole('menuitemradio', { name: 'Ajuster à la largeur' }).click()
    await expect(page.getByTestId('zoom-level')).toHaveText('Ajuster à la largeur')
  })

  await test.step('the PDF, the sources and the output files download', async () => {
    const [pdfFile] = await Promise.all([
      page.waitForEvent('download'),
      page.getByTestId('download-pdf').click(),
    ])
    expect(pdfFile.suggestedFilename()).toMatch(/\.pdf$/)

    await page.getByTestId('pdf-more-menu').click()
    const [zip] = await Promise.all([
      page.waitForEvent('download'),
      page.getByTestId('download-zip').click(),
    ])
    expect(zip.suggestedFilename()).toMatch(/\.zip$/)

    await page.getByTestId('pdf-more-menu').click()
    await page.getByRole('menuitem', { name: 'Fichiers de sortie' }).hover()
    const [log] = await Promise.all([
      page.waitForEvent('download'),
      page.getByTestId('output-output.log').click(),
    ])
    expect(log.suggestedFilename()).toMatch(/\.log$/)
  })

  await test.step('the floating bar pages through the PDF and goes to the cursor', async () => {
    await expect(pdfPosition(page)).toHaveText('1 / 3')
    await pdf.getByRole('button', { name: 'Page suivante' }).click()
    await expect(pdfPosition(page)).toHaveText('2 / 3')
    await pdf.getByRole('button', { name: 'Page précédente' }).click()
    await expect(pdfPosition(page)).toHaveText('1 / 3')
    // « Aller au PDF » (SyncTeX) depuis la ligne du curseur.
    await placeCursorOn(page, 'Texte de la page trois.')
    await page.getByTestId('synctex-to-pdf').click()
    await expect(pdfPosition(page)).toHaveText('3 / 3')
  })

  await test.step('undo and redo from the floating bar', async () => {
    await appendToEditor(page, 'Ligne à annuler.')
    await pdf.getByRole('button', { name: 'Annuler', exact: true }).click()
    await waitSynced(page)
    await expect.poll(() => editorText(page)).not.toContain('Ligne à annuler.')
    await pdf.getByRole('button', { name: 'Rétablir', exact: true }).click()
    await waitSynced(page)
    await expect.poll(() => editorText(page)).toContain('Ligne à annuler.')
  })
})

test('workspace filter from the sidebar footer and the dashboard', async ({ accounts }) => {
  const owner = await accounts.create(PEOPLE.ada)
  const other = await accounts.create(PEOPLE.grace)
  const sharedId = await importProject(other.page, 'Projet de Grace', demoProjectFiles())
  await addMember(other, owner, sharedId, 'editor')
  const ownId = await importProject(owner.page, DEMO_NAME, demoProjectFiles())
  const { project } = await api<{ project: { workspaceId: string } }>(
    owner.page,
    'GET',
    `/projects/${ownId}`,
  )
  const { workspaces } = await api<{ workspaces: { id: string; type: string }[] }>(
    owner.page,
    'GET',
    '/workspaces',
  )
  const workspace = workspaces.find((candidate) => candidate.id === project.workspaceId)
  if (workspace === undefined) throw new Error('the project workspace is not listed')
  const page = owner.page
  const rows = page.getByTestId('project-row')

  // Pied de la sidebar du projet : workspace du projet (le personnel s'affiche « Personnel »),
  // menu vers le tableau de bord filtré.
  const switcher = page.getByTestId('workspace-switcher').filter({ visible: true }).first()
  await expect(switcher).toHaveText('Personnel')
  await switcher.click()
  await page.getByRole('menuitemradio', { name: 'Personnel' }).click()
  await expect(page).toHaveURL(new RegExp(`/dashboard\\?workspace=${workspace.id}$`))
  await expect(rows.filter({ hasText: DEMO_NAME })).toHaveCount(1)
  await expect(rows.filter({ hasText: 'Projet de Grace' })).toHaveCount(0)

  // Tous les projets : les projets partagés reviennent.
  await page.getByTestId('workspace-switcher').filter({ visible: true }).first().click()
  await page.getByRole('menuitem', { name: 'Tous les projets' }).click()
  await expect(page).toHaveURL(/\/dashboard$/)
  await expect(rows.filter({ hasText: 'Projet de Grace' })).toHaveCount(1)
  await expect(rows.filter({ hasText: DEMO_NAME })).toHaveCount(1)
})
