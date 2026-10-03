import { readFile } from 'node:fs/promises'
import { type Account, expect, PEOPLE, test } from './accounts'
import { api } from './api'
import { readZip, solidPng } from './files'
import {
  addMember,
  compile,
  editorLine,
  editorText,
  importProject,
  openInTree,
  openProject,
  PLOT_PNG,
  replaceEditorContent,
  waitSynced,
} from './project'

/**
 * Historique (étape 2) : version créée par une compilation, diff coloré par auteur, label,
 * restauration exacte du texte et d'une image (projet entier, ou un seul fichier), et
 * téléchargement d'une version en zip.
 */
const BASE = [
  '\\documentclass{article}',
  '\\usepackage{graphicx}',
  '\\begin{document}',
  'Première version du texte.',
  '\\includegraphics[width=3cm]{courbe.png}',
  '\\end{document}',
  '',
].join('\n')

/** Texte de la version compilée : une ligne ajoutée par chaque autrice. */
const VERSION_TEXT = BASE.replace(
  'Première version du texte.',
  'Première version du texte.\nAjout de Grace.\nAjout d’Ada.',
)
const LABEL = 'Version relue'

interface TreeFile {
  id: string
  path: string
}

/** Ajoute une ligne après celle qui contient `after`. */
async function addLineAfter(account: Account, after: string, text: string): Promise<void> {
  await editorLine(account.page, after).click({ position: { x: 8, y: 6 } })
  await account.page.keyboard.press('End')
  await account.page.keyboard.insertText(`\n${text}`)
  await waitSynced(account.page)
}

/** Octets d'un fichier du projet (lien présigné du stockage). */
async function fileBytes(account: Account, projectId: string, path: string): Promise<Buffer> {
  const { files } = await api<{ files: TreeFile[] }>(
    account.page,
    'GET',
    `/projects/${projectId}/tree`,
  )
  const file = files.find((candidate) => candidate.path === path)
  if (file === undefined) throw new Error(`${path} is not in the project`)
  const { url } = await api<{ url: string }>(
    account.page,
    'GET',
    `/projects/${projectId}/files/${file.id}/url`,
  )
  const response = await account.page.request.get(url)
  expect(response.ok()).toBe(true)
  return response.body()
}

test('versions, author diff, label, exact restore and zip download', async ({
  accounts,
}, testInfo) => {
  test.setTimeout(360_000)
  const owner = await accounts.create(PEOPLE.ada)
  const editor = await accounts.create(PEOPLE.grace)
  const projectId = await importProject(owner.page, 'Historique', [
    { path: 'main.tex', data: BASE },
    { path: 'courbe.png', data: PLOT_PNG },
  ])
  await addMember(owner, editor, projectId, 'editor')
  await openProject(editor.page, projectId)

  await test.step('two authors edit, a compilation creates a version', async () => {
    await addLineAfter(editor, 'Première version du texte.', 'Ajout de Grace.')
    await expect(editorLine(owner.page, 'Ajout de Grace.')).toBeVisible()
    await addLineAfter(owner, 'Ajout de Grace.', 'Ajout d’Ada.')
    await expect.poll(() => editorText(editor.page)).toBe(VERSION_TEXT)
    expect((await compile(owner.page)).status).toBe('success')
  })

  const drawer = owner.page.getByTestId('history-drawer')
  await test.step('the version diff is coloured by author', async () => {
    await owner.page.getByTestId('history-button').click()
    const version = drawer.getByTestId('history-version').filter({ hasText: 'Compilation' })
    await expect(version.first()).toContainText(owner.name)
    await expect(version.first()).toContainText(editor.name)
    await version.first().click()
    const diff = drawer.getByTestId('history-diff')
    // Chaque ajout porte le nom de son autrice (couleur et infobulle).
    await expect(
      diff.locator(`[title="Ajouté par ${editor.name}"]`).filter({ hasText: 'Ajout de Grace.' }),
    ).not.toHaveCount(0)
    await expect(
      diff.locator(`[title="Ajouté par ${owner.name}"]`).filter({ hasText: 'Ajout d’Ada.' }),
    ).not.toHaveCount(0)
    // Légende : les deux autrices, avec leurs lignes ajoutées et retirées.
    await expect(diff).toContainText(owner.name)
    await expect(diff).toContainText(editor.name)

    await drawer.getByRole('button', { name: 'Nommer', exact: true }).click()
    await drawer.getByRole('textbox', { name: 'Nom de la version' }).fill(LABEL)
    await drawer.getByRole('button', { name: 'Enregistrer', exact: true }).click()
    await expect(drawer.getByTestId('history-version-view')).toContainText(LABEL)
    await drawer.getByRole('button', { name: 'Retour aux versions' }).click()
    await expect(drawer.getByTestId('history-version').filter({ hasText: LABEL })).toHaveCount(1)
    await owner.page.keyboard.press('Escape')
  })

  await test.step('the text and the image change after the version', async () => {
    await replaceEditorContent(
      owner.page,
      BASE.replace('Première version du texte.', 'Texte entièrement réécrit.'),
    )
    const { files } = await api<{ files: TreeFile[] }>(
      owner.page,
      'GET',
      `/projects/${projectId}/tree`,
    )
    const image = files.find((file) => file.path === 'courbe.png')
    if (image === undefined) throw new Error('courbe.png is missing')
    await api(owner.page, 'DELETE', `/projects/${projectId}/entities/file/${image.id}`)
    await expect(owner.page.locator('[data-path="courbe.png"]')).toHaveCount(0)
    await owner.page.getByTestId('upload-input').setInputFiles({
      name: 'courbe.png',
      mimeType: 'image/png',
      buffer: solidPng(64, 48, [220, 60, 40]),
    })
    await expect(owner.page.locator('[data-path="courbe.png"]')).toBeVisible()
    expect((await fileBytes(owner, projectId, 'courbe.png')).equals(PLOT_PNG)).toBe(false)
  })

  await test.step('restoring the labelled version gives back the exact text and image', async () => {
    await owner.page.getByTestId('history-button').click()
    await drawer.getByTestId('history-version').filter({ hasText: LABEL }).click()
    await drawer.getByTestId('history-restore-project').click()
    const confirm = owner.page.getByRole('dialog', { name: 'Restaurer cette version ?' })
    await confirm.getByTestId('history-restore-confirm').click()
    await expect(
      drawer.getByRole('status').filter({
        hasText: 'La version a été restaurée. L’état précédent est enregistré dans l’historique.',
      }),
    ).toBeVisible()
    // L'état précédent est gardé dans une version « Avant restauration ».
    await expect(
      drawer.getByTestId('history-version').filter({ hasText: 'Avant restauration' }),
    ).toHaveCount(1)
    await owner.page.keyboard.press('Escape')
    await expect.poll(() => editorText(owner.page)).toBe(VERSION_TEXT)
    // Les collaborateurs connectés voient le changement aussitôt.
    await expect.poll(() => editorText(editor.page)).toBe(VERSION_TEXT)
    expect((await fileBytes(owner, projectId, 'courbe.png')).equals(PLOT_PNG)).toBe(true)
  })

  await test.step('a version downloads as a zip', async () => {
    await owner.page.getByTestId('history-button').click()
    await drawer.getByTestId('history-version').filter({ hasText: LABEL }).click()
    const [download] = await Promise.all([
      owner.page.waitForEvent('download'),
      drawer.getByRole('button', { name: 'Zip', exact: true }).click(),
    ])
    const path = testInfo.outputPath('version.zip')
    await download.saveAs(path)
    const files = readZip(await readFile(path))
    expect(files.get('main.tex')?.toString('utf8')).toBe(VERSION_TEXT)
    expect(files.get('courbe.png')?.equals(PLOT_PNG)).toBe(true)
  })
})

test('restoring a single file leaves the other files as they are', async ({ accounts }) => {
  const owner = await accounts.create(PEOPLE.ada)
  const notes = 'Notes de la première version.\nDeuxième ligne des notes.\n'
  const projectId = await importProject(owner.page, 'Restauration d’un fichier', [
    {
      path: 'main.tex',
      data: [
        '\\documentclass{article}',
        '\\begin{document}',
        'Première version du texte.',
        '\\input{notes}',
        '\\end{document}',
        '',
      ].join('\n'),
    },
    { path: 'notes.tex', data: notes },
  ])
  const page = owner.page
  expect((await compile(page)).status).toBe('success')
  const { versions } = await api<{ versions: { id: string }[] }>(
    page,
    'GET',
    `/projects/${projectId}/versions`,
  )
  const latest = versions[0]
  if (latest === undefined) throw new Error('no version after the compilation')
  await api(page, 'PATCH', `/projects/${projectId}/versions/${latest.id}`, { label: LABEL })

  // Les deux fichiers changent après la version.
  await replaceEditorContent(page, (await editorText(page)).replace('Première version', 'Réécrit'))
  const mainAfter = await editorText(page)
  await openInTree(page, 'notes.tex')
  await replaceEditorContent(page, 'Notes entièrement réécrites.\n')

  const drawer = page.getByTestId('history-drawer')
  await page.getByTestId('history-button').click()
  await drawer.getByTestId('history-version').filter({ hasText: LABEL }).click()
  const view = drawer.getByTestId('history-version-view')
  await view.getByRole('button', { name: /notes\.tex/ }).click()
  await view.getByRole('button', { name: 'Restaurer ce fichier' }).click()
  const confirm = page.getByRole('dialog', { name: 'Restaurer notes.tex ?' })
  await confirm.getByTestId('history-restore-confirm').click()
  await expect(confirm).toBeHidden()
  await page.keyboard.press('Escape')

  await expect.poll(() => editorText(page)).toBe(notes)
  await openInTree(page, 'main.tex')
  await expect.poll(() => editorText(page)).toBe(mainAfter)
})
