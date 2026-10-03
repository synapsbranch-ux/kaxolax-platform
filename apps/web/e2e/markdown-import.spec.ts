import type { Page } from '@playwright/test'
import { expect, test } from './accounts'
import {
  activeTab,
  compile,
  editorText,
  expectPdfText,
  importProject,
  openInTree,
  PLOT_PNG,
  placeCursorOn,
  runTool,
  waitSynced,
} from './project'

/**
 * Markdown → LaTeX (étape 3, tâche 5) : pandoc tourne dans le sandbox de compilation. Collage
 * dans la boîte « Importer du Markdown » avec aperçu et insertion dans le document courant
 * (préambule du document principal complété sans doublon), conversion d'un `.md` du projet en
 * nouveau fichier inclus par `\input`, collage intelligent dans l'éditeur, proposition après
 * l'upload d'un `.md`. Chaque résultat compile. Un compte et un projet par parcours.
 */
const MAIN = [
  '\\documentclass{article}',
  '\\usepackage[T1]{fontenc}',
  '\\usepackage{hyperref}',
  '\\begin{document}',
  'Début du document.',
  '\\end{document}',
  '',
].join('\n')

const MARKDOWN = [
  '# Résultats',
  '',
  'Une mesure **importante** et un [lien](https://pandoc.org)[^1].',
  '',
  '[^1]: Source : le laboratoire.',
  '',
  '- premier point',
  '- second point',
  '',
  '| Essai | Valeur |',
  '|-------|-------:|',
  '| A     | $x^2$  |',
  '',
  '> Une citation.',
  '',
].join('\n')

/** Ouvre la boîte « Importer du Markdown » par la barre Tools (menu Fichier). */
async function openImport(page: Page) {
  await runTool(page, 'file', 'file.import-markdown')
  const dialog = page.getByTestId('markdown-import')
  await expect(dialog.getByRole('heading', { name: 'Importer du Markdown' })).toBeVisible()
  return dialog
}

/** Menu « Actions pour … » d'une ligne de l'arborescence. */
async function treeAction(page: Page, path: string, action: string): Promise<void> {
  const row = page.locator(`[data-path="${path}"]`)
  await row.hover()
  const name = path.slice(path.lastIndexOf('/') + 1)
  await row.getByRole('button', { name: `Actions pour ${name}`, exact: true }).click()
  await page.getByRole('menuitem', { name: action, exact: true }).click()
}

/** Colle `text` dans l'éditeur comme le presse-papiers (événement `paste` du navigateur). */
async function pasteInEditor(page: Page, text: string): Promise<void> {
  await page.locator('.cm-content').evaluate((content, pasted) => {
    const data = new DataTransfer()
    data.setData('text/plain', pasted)
    content.dispatchEvent(
      new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }),
    )
  }, text)
}

test('pasted Markdown: preview, insertion and main preamble completed once', async ({
  accounts,
}) => {
  const { page } = await accounts.create()
  await importProject(page, 'Markdown', [{ path: 'main.tex', data: MAIN }])
  await placeCursorOn(page, 'Début du document.')
  await page.keyboard.press('End')
  await page.keyboard.press('Enter')

  const dialog = await openImport(page)
  await dialog.getByLabel('Markdown', { exact: true }).fill(MARKDOWN)
  await expect(dialog.getByRole('radio', { name: 'Document courant' })).toHaveAttribute(
    'aria-checked',
    'true',
  )
  await dialog.getByRole('button', { name: 'Aperçu', exact: true }).click()
  const preview = dialog.getByTestId('markdown-preview')
  await expect(preview).toContainText('\\section{Résultats}')
  await expect(preview).toContainText('\\footnote{Source : le laboratoire.}')
  await expect(preview).toContainText('\\begin{longtable}')
  // hyperref est déjà chargé : seuls les autres packages sont proposés.
  const lacking = dialog.getByText(/À ajouter au préambule de main\.tex/)
  await expect(lacking).toContainText('amsmath')
  await expect(lacking).not.toContainText('hyperref')
  await dialog.getByRole('button', { name: 'Insérer', exact: true }).click()
  await expect(dialog).toBeHidden()
  await waitSynced(page)

  const text = await editorText(page)
  expect(text).toContain('\\section{Résultats}')
  expect(text).toContain('\\usepackage{amsmath}')
  expect(text).toContain('\\usepackage{longtable}')
  expect(text.match(/\\usepackage\{hyperref\}/g)).toHaveLength(1)
  // hyperref reste chargé en dernier.
  expect(text.indexOf('\\usepackage{longtable}')).toBeLessThan(
    text.indexOf('\\usepackage{hyperref}'),
  )
  expect(text).toContain('\\providecommand{\\tightlist}')

  const result = await compile(page)
  expect(result.status).toBe('success')
  await expectPdfText(page, 'Résultats', 'importante', 'premier point')

  // Second import : le préambule a déjà tout, rien n'est ajouté en double.
  const again = await openImport(page)
  await again.getByLabel('Markdown', { exact: true }).fill('## Suite\n\n- a **b**\n- c\n')
  await again.getByRole('button', { name: 'Aperçu', exact: true }).click()
  await expect(again.getByText('Préambule de main.tex : rien à ajouter.')).toBeVisible()
  await again.getByRole('button', { name: 'Insérer', exact: true }).click()
  await expect(again).toBeHidden()
  await waitSynced(page)
  expect((await editorText(page)).match(/\\providecommand\{\\tightlist\}/g)).toHaveLength(1)
})

test('a Markdown file of the project becomes a new .tex file included by the main document', async ({
  accounts,
}) => {
  const { page } = await accounts.create()
  await importProject(page, 'Notes', [
    { path: 'main.tex', data: MAIN },
    { path: 'notes/README.md', data: `${MARKDOWN}\n![Graphique](../figures/plot.png)\n` },
    { path: 'figures/plot.png', data: PLOT_PNG },
  ])

  await treeAction(page, 'notes/README.md', 'Convertir en LaTeX…')
  const dialog = page.getByTestId('markdown-import')
  await expect(dialog.getByLabel('Fichier Markdown')).toHaveValue(/.+/)
  await expect(dialog.getByLabel('Fichier à créer')).toHaveValue('notes/README.tex')
  await expect(dialog.getByLabel(/Inclure le fichier dans main\.tex/)).toBeChecked()
  await dialog.getByRole('button', { name: 'Créer le fichier', exact: true }).click()
  await expect(dialog).toBeHidden()

  // Le document principal inclut le fichier créé, qui s'ouvre ensuite.
  await expect(activeTab(page)).toHaveAttribute('data-tab-path', 'notes/README.tex')
  expect(await editorText(page)).toContain('\\includegraphics')
  await openInTree(page, 'main.tex')
  const main = await editorText(page)
  expect(main).toContain('\\input{notes/README}')
  expect(main).toContain('\\usepackage{graphicx}')

  const result = await compile(page)
  expect(result.status).toBe('success')
  await expectPdfText(page, 'Résultats', 'Une citation.')
})

test('smart paste and upload propose the conversion', async ({ accounts }) => {
  const { page } = await accounts.create()
  await importProject(page, 'Collage', [{ path: 'main.tex', data: MAIN }])
  await placeCursorOn(page, 'Début du document.')
  await page.keyboard.press('End')
  await page.keyboard.press('Enter')

  // Le Markdown collé reste tel quel ; la proposition le remplace par sa conversion.
  await pasteInEditor(page, '## Collé\n\n- **un**\n- deux\n')
  const proposal = page.getByTestId('markdown-proposal')
  await expect(proposal).toContainText('ressemble à du Markdown')
  expect(await editorText(page)).toContain('## Collé')
  await proposal.getByRole('button', { name: 'Convertir en LaTeX' }).click()
  const dialog = page.getByTestId('markdown-import')
  await expect(dialog.getByLabel('Markdown', { exact: true })).toHaveValue(/## Collé/)
  await expect(dialog.getByText('à la place du texte collé')).toBeVisible()
  await dialog.getByRole('button', { name: 'Insérer', exact: true }).click()
  await expect(dialog).toBeHidden()
  await waitSynced(page)
  const text = await editorText(page)
  expect(text).toContain('\\subsection{Collé}')
  expect(text).not.toContain('## Collé')

  // Du LaTeX collé ne déclenche rien.
  await pasteInEditor(page, '\\textbf{a} \\emph{b} \\cite{c}')
  await expect(proposal).toBeHidden()

  // Un .md uploadé : conversion proposée.
  await page.getByTestId('upload-input').setInputFiles({
    name: 'chapitre.md',
    mimeType: 'text/markdown',
    buffer: Buffer.from(MARKDOWN),
  })
  await expect(proposal).toContainText('chapitre.md est un fichier Markdown.')
  await proposal.getByRole('button', { name: 'Convertir en LaTeX' }).click()
  await expect(dialog.getByLabel('Fichier à créer')).toHaveValue('chapitre.tex')
  await dialog.getByRole('button', { name: 'Annuler', exact: true }).click()
})
