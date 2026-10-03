import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { deleteOwnedProjects } from './api'
import { deleteTestUserByEmail, signIn, signOut, signUp, testEmail } from './clerk'
import {
  activeLine,
  chooseCompiler,
  compile,
  expectPdfText,
  FIXTURES,
  openInTree,
  replaceEditorContent,
} from './project'

/**
 * « Définition de terminé » de l'étape 1, automatisée : compte, projet, upload, écriture,
 * compilations pdfLaTeX et XeLaTeX, erreur, SyncTeX, export et réimport, reconnexion, puis
 * recompilation à chaud d'un document de 10 pages en moins de 3 s. Depuis l'étape 2, le compte est
 * créé et la connexion faite par Clerk (instance de développement, adresse +clerk_test) ; les
 * compilations sont suivies dans les deux modes de l'API (synchrone ou 202 suivi, `compile()`).
 * Le compte et ses projets sont supprimés à la fin.
 */

const fixtures = FIXTURES
const email = testEmail('dod')

test.afterEach(async ({ page }) => {
  try {
    await page.goto('/dashboard')
    await deleteOwnedProjects(page)
  } catch (error) {
    console.warn('could not delete the projects of the journey', error)
  }
  await deleteTestUserByEmail(email)
})

const INTRO = [
  '\\section{Introduction}',
  'As shown by Knuth~\\cite{knuth}, typesetting is an art.',
  '',
].join('\n')

/** main.tex : figure, citation et section incluse par \input. La ligne 9 sert à SyncTeX. */
const MAIN = [
  '\\documentclass{article}', // 1
  '\\usepackage{graphicx}', // 2
  '\\begin{document}', // 3
  '\\input{intro}', // 4
  '\\begin{figure}[h]', // 5
  '\\centering\\includegraphics[width=4cm]{plot.png}', // 6
  '\\caption{A generated plot}', // 7
  '\\end{figure}', // 8
  'A paragraph used to check SyncTeX in both directions.', // 9
  '', // 10
  '\\bibliographystyle{plain}', // 11
  '\\bibliography{refs}', // 12
  '\\end{document}', // 13
  '',
].join('\n')
const SYNCTEX_LINE = 9

/** Document simple de 10 pages (une section par page) pour la recompilation à chaud. */
function tenPages(edit: string): string {
  const paragraph = 'A simple paragraph of text that fills the page. '.repeat(40)
  const sections = Array.from({ length: 10 }, (_, index) =>
    [
      `\\section{Part ${String(index + 1)}}`,
      index === 0 ? edit : '',
      paragraph,
      '\\clearpage',
    ].join('\n'),
  )
  return ['\\documentclass{article}', '\\begin{document}', ...sections, '\\end{document}', ''].join(
    '\n',
  )
}

test('stage 1 definition of done', async ({ page }, testInfo) => {
  await test.step('1. create an account (Clerk), confirm the email, land on the dashboard', async () => {
    await signUp(page, { email, firstName: 'Ada', lastName: 'Lovelace' })
  })

  let projectUrl = ''
  await test.step('2. create a blank project, upload an image and a .bib file', async () => {
    await page.getByRole('button', { name: 'Nouveau projet', exact: true }).click()
    await page.fill('#name-dialog-input', 'Definition of done')
    await page.getByRole('button', { name: 'Créer' }).click()
    await expect(page).toHaveURL(/\/project\/[0-9a-f-]{36}$/)
    projectUrl = page.url()
    await expect(page.locator('.cm-content')).toContainText('\\documentclass')

    await page
      .getByTestId('upload-input')
      .setInputFiles([join(fixtures, 'plot.png'), join(fixtures, 'refs.bib')])
    await expect(page.locator('[data-path="plot.png"]')).toBeVisible()
    await expect(page.locator('[data-path="refs.bib"]')).toBeVisible()
    await page.locator('[data-path="plot.png"]').click()
    await expect(page.getByTestId('image-preview')).toBeVisible()
  })

  await test.step('3. write a document with a figure, a citation and a section in an \\input file', async () => {
    await page.getByTestId('sidebar-add').click()
    await page.getByRole('menuitem', { name: 'Nouveau fichier' }).click()
    await page.fill('#name-dialog-input', 'intro.tex')
    await page.getByRole('button', { name: 'Créer' }).click()
    await expect(page.locator('[data-path="intro.tex"]')).toBeVisible()
    await replaceEditorContent(page, INTRO)
    await openInTree(page, 'main.tex')
    await replaceEditorContent(page, MAIN)
  })

  await test.step('4. compile with pdfLaTeX, then XeLaTeX: figure and bibliography are in the PDF', async () => {
    const pdflatex = await compile(page)
    expect(pdflatex.status).toBe('success')
    await expectPdfText(page, 'Introduction', 'A generated plot', 'References', 'The TeXbook')

    await chooseCompiler(page, 'XeLaTeX')
    const xelatex = await compile(page)
    expect(xelatex.status).toBe('success')
    await expectPdfText(page, 'A generated plot', 'The TeXbook')
  })

  await test.step('5. an error opens the editor on the right line', async () => {
    await replaceEditorContent(
      page,
      MAIN.replace('A paragraph used', 'A \\undefinedmacro paragraph used'),
    )
    const failed = await compile(page)
    expect(failed.status).toBe('failure')
    await expect(page.getByTestId('error-count')).toHaveText('1')
    await page.getByTestId('panel-logs').click()
    // Le curseur est ailleurs avant le clic.
    await page.locator('.cm-line').first().click()
    await page.getByTestId('log-error').first().click()
    await expect.poll(() => activeLine(page)).toBe(String(SYNCTEX_LINE))
  })

  await test.step('6. SyncTeX from code to PDF and from PDF to code', async () => {
    await replaceEditorContent(page, MAIN)
    expect((await compile(page)).status).toBe('success')
    await expectPdfText(page, 'SyncTeX in both directions')

    await page
      .locator('.cm-line')
      .nth(SYNCTEX_LINE - 1)
      .click()
    await page.getByTestId('synctex-to-pdf').click()
    await expect(page.getByTestId('synctex-highlight')).toBeVisible()

    await page.locator('.cm-line').first().click()
    await expect.poll(() => activeLine(page)).toBe('1')
    await page
      .getByTestId('pdf-viewer')
      .locator('.textLayer span', { hasText: 'SyncTeX in both' })
      .first()
      .dblclick()
    await expect.poll(() => activeLine(page)).toBe(String(SYNCTEX_LINE))
  })

  await test.step('7. download the zip and import it back: it compiles the same way', async () => {
    await page.getByTestId('pdf-more-menu').click()
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.getByTestId('download-zip').click(),
    ])
    const zipPath = testInfo.outputPath('project.zip')
    await download.saveAs(zipPath)

    await page.goto('/dashboard')
    await page.getByTestId('import-input').setInputFiles(zipPath)
    await expect(page).toHaveURL(/\/project\/[0-9a-f-]{36}$/)
    expect(page.url()).not.toBe(projectUrl)
    await expect(page.locator('[data-path="intro.tex"]')).toBeVisible()
    await expect(page.locator('[data-path="plot.png"]')).toBeVisible()
    const reimported = await compile(page)
    expect(reimported.status).toBe('success')
    await expectPdfText(page, 'A generated plot', 'The TeXbook', 'SyncTeX in both directions')
  })

  await test.step('8. log out, log in again, reopen the project: content and last PDF are there', async () => {
    await signOut(page)
    await signIn(page, email)
    await page.getByRole('link', { name: 'Definition of done' }).first().click()
    await expect(page).toHaveURL(projectUrl)
    await expect(page.locator('.cm-content')).toContainText('SyncTeX in both directions')
    await expectPdfText(page, 'A generated plot', 'The TeXbook')
  })

  await test.step('9. a simple 10-page document recompiles in under 3 s once warm', async () => {
    await chooseCompiler(page, 'pdfLaTeX')
    await replaceEditorContent(page, tenPages('First version.'))
    expect((await compile(page)).status).toBe('success')
    await expect(page.getByTestId('pdf-page-count')).toHaveText('10')

    await replaceEditorContent(page, tenPages('Edited version.'))
    const warm = await compile(page)
    expect(warm.status).toBe('success')
    // Durée mesurée par l'agent de compilation (instance déployée : le Worker, sous gVisor).
    testInfo.annotations.push({
      type: 'warm 10-page recompile',
      description: `${String(warm.durationMs)} ms`,
    })
    expect(warm.durationMs).toBeLessThan(3_000)
    await expectPdfText(page, 'Edited version.')
  })
})
