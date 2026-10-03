import type { Locator, Page } from '@playwright/test'
import { expect, test } from './accounts'
import { api } from './api'
import {
  compile,
  editorLine,
  editorText,
  expectPdfText,
  importProject,
  openProject,
  placeCursorAfter,
  placeCursorOn,
  PLOT_PNG,
  REFS_BIB,
  runTool,
  waitForEditor,
  waitSynced,
} from './project'

/**
 * Outils d'écriture (étape 2) : formules MathLive, symboles (package ajouté, récents), tableaux
 * (aller-retour sans perte, collage depuis un tableur, fichier CSV, cases fusionnées),
 * gestionnaire de packages, correction d'un package mal écrit depuis les logs, compteur de mots
 * (légendes, détail par section), paramètres de l'éditeur (thème, coloration, police, hauteur de
 * ligne, raccourcis, retour à la ligne, correcteur ; appliqués sur un autre appareil) et
 * autocomplétion (citations en moins de 100 ms, labels, commandes des packages chargés, chemins).
 * Chaque outil insère du LaTeX qui compile. Un compte et un projet par parcours.
 */
const MAIN = [
  '\\documentclass{article}',
  '\\begin{document}',
  '\\section{Outils}',
  'Formule :',
  'Symbole :',
  'Comme l’a montré Knuth',
  '\\end{document}',
  '',
].join('\n')

/** Place le curseur à la fin de la ligne qui contient `text`. */
async function cursorAtEndOf(page: Page, text: string): Promise<void> {
  await placeCursorOn(page, text)
  await page.keyboard.press('End')
}

test('formula editor: MathLive insertion, then reopened on the formula', async ({ accounts }) => {
  const { page } = await accounts.create()
  await importProject(page, 'Formules', [{ path: 'main.tex', data: MAIN }])
  await cursorAtEndOf(page, 'Formule :')

  await runTool(page, 'math', 'math.formula')
  const dialog = page.getByRole('dialog', { name: 'Éditeur de formules' })
  // Champ visuel MathLive chargé à la première ouverture.
  await expect(dialog.locator('math-field')).toBeVisible()
  await dialog.getByLabel('LaTeX', { exact: true }).fill('\\frac{a}{b}+\\sqrt{2}')
  await dialog.getByRole('radio', { name: 'Centrée' }).click()
  // Aperçu du texte inséré : formule centrée.
  const preview = dialog.locator('pre')
  await expect(preview).toContainText('\\[')
  const inserted = (await preview.textContent()) ?? ''
  expect(inserted).toContain('\\frac{a}{b}')
  await dialog.getByRole('button', { name: 'Insérer', exact: true }).click()
  await expect(dialog).toBeHidden()
  await waitSynced(page)
  expect(await editorText(page)).toContain(inserted.trim())

  // Rouverte sur la formule sous le curseur : elle est remplacée exactement.
  await placeCursorAfter(page, '\\frac{a}{b}')
  await runTool(page, 'math', 'math.formula')
  const editing = page.getByRole('dialog', { name: 'Modifier la formule' })
  await expect(editing.getByLabel('LaTeX', { exact: true })).toHaveValue(/\\frac\{a\}\{b\}/)
  await expect(editing.getByRole('radio', { name: 'Centrée' })).toHaveAttribute(
    'aria-checked',
    'true',
  )
  await editing.getByLabel('LaTeX', { exact: true }).fill('\\frac{a}{c}')
  await editing.getByRole('button', { name: 'Remplacer', exact: true }).click()
  await expect(editing).toBeHidden()
  await waitSynced(page)
  const text = await editorText(page)
  expect(text).toContain('\\frac{a}{c}')
  expect(text).not.toContain('\\frac{a}{b}')
  expect(text.match(/\\\[/g)).toHaveLength(1)
  // La formule insérée puis remplacée compile.
  expect((await compile(page)).status).toBe('success')
})

test('symbol picker: a symbol whose package is added in one click', async ({ accounts }) => {
  const { page } = await accounts.create()
  await importProject(page, 'Symboles', [{ path: 'main.tex', data: MAIN }])
  await cursorAtEndOf(page, 'Symbole :')

  await runTool(page, 'math', 'math.symbols')
  const dialog = page.getByRole('dialog', { name: 'Symboles' })
  await dialog.getByRole('searchbox', { name: 'Rechercher un symbole' }).fill('leqslant')
  const symbol = dialog.getByRole('option', { name: 'inférieur ou égal (oblique) (\\leqslant)' })
  await symbol.hover()
  await expect(dialog).toContainText('Package absent du préambule : amssymb.')
  await dialog.getByRole('button', { name: 'Ajouter au préambule' }).click()
  await expect(dialog).not.toContainText('Package absent du préambule')
  await dialog.getByRole('button', { name: 'Insérer', exact: true }).click()
  await expect(dialog).toBeHidden()
  await waitSynced(page)
  const text = await editorText(page)
  expect(text).toContain('\\usepackage{amssymb}')
  expect(text).toContain('Symbole :\\(\\leqslant\\)')
  expect((await compile(page)).status).toBe('success')

  // Symbole récent : en tête de l'onglet « Récents », ouvert par défaut, et gardé dans le compte.
  await runTool(page, 'math', 'math.symbols')
  const reopened = page.getByRole('dialog', { name: 'Symboles' })
  await expect(reopened.getByRole('tab', { name: 'Récents' })).toHaveAttribute(
    'aria-selected',
    'true',
  )
  await expect(reopened.getByRole('option').first()).toHaveAccessibleName(
    'inférieur ou égal (oblique) (\\leqslant)',
  )
  await page.keyboard.press('Escape')
  const { preferences } = await api<{ preferences: { recentSymbols: string[] } }>(
    page,
    'GET',
    '/me/preferences',
  )
  expect(preferences.recentSymbols[0]).toBe('\\leqslant')
})

test('table generator: inserted, reopened, edited and inserted again', async ({ accounts }) => {
  const { page } = await accounts.create()
  await importProject(page, 'Tableaux', [{ path: 'main.tex', data: MAIN }])
  await cursorAtEndOf(page, 'Comme l’a montré Knuth')

  await runTool(page, 'structures', 'structures.table')
  const dialog = page.getByRole('dialog', { name: 'Nouveau tableau' })
  const cells: Record<string, string> = {
    A1: 'Matériau',
    B1: 'Conductivité',
    C1: 'Écart',
    A2: 'Cuivre',
    B2: '401',
    C2: '1,2',
    A3: 'Acier',
    B3: '50',
    C3: '4,1',
  }
  for (const [cell, value] of Object.entries(cells)) {
    await dialog.getByRole('textbox', { name: `Case ${cell}`, exact: true }).fill(value)
  }
  await dialog.getByLabel('Légende', { exact: true }).first().fill('Conductivités mesurées')
  await dialog.getByRole('button', { name: 'Insérer', exact: true }).click()
  await expect(dialog).toBeHidden()
  await waitSynced(page)
  const text = await editorText(page)
  expect(text).toContain('\\usepackage{booktabs}')
  // Cases alignées par des espaces dans le code généré.
  expect(text).toMatch(/Cuivre\s*& 401\s*& 1,2 \\\\/)
  expect(text).toContain('\\caption{Conductivités mesurées}')

  await placeCursorOn(page, 'Cuivre')
  await runTool(page, 'structures', 'structures.table')
  const editing = page.getByRole('dialog', { name: 'Modifier le tableau' })
  for (const [cell, value] of Object.entries(cells)) {
    await expect(editing.getByRole('textbox', { name: `Case ${cell}`, exact: true })).toHaveValue(
      value,
    )
  }
  // Modification d'une case et d'une ligne ajoutée en dessous, puis réinsertion à la même place.
  await editing.getByRole('textbox', { name: 'Case B2', exact: true }).fill('398')
  await editing.getByRole('textbox', { name: 'Case A3', exact: true }).click()
  await editing.getByRole('button', { name: 'Insérer une ligne en dessous' }).click()
  const added = { A4: 'Aluminium', B4: '237', C4: '2,8' }
  for (const [cell, value] of Object.entries(added)) {
    await editing.getByRole('textbox', { name: `Case ${cell}`, exact: true }).fill(value)
  }
  await editing.getByRole('button', { name: 'Remplacer', exact: true }).click()
  await expect(editing).toBeHidden()
  await waitSynced(page)
  const replaced = await editorText(page)
  expect(replaced.match(/\\begin\{tabular\}/g)).toHaveLength(1)
  expect(replaced).toMatch(/Cuivre\s*& 398\s*& 1,2 \\\\/)
  expect(replaced).toMatch(/Aluminium\s*& 237\s*& 2,8 \\\\/)
  expect(replaced).not.toMatch(/& 401\s*&/)
  expect(replaced).toContain('\\caption{Conductivités mesurées}')
  // Rouvert une seconde fois : rien n'est perdu.
  await placeCursorOn(page, 'Aluminium')
  await runTool(page, 'structures', 'structures.table')
  const again = page.getByRole('dialog', { name: 'Modifier le tableau' })
  for (const [cell, value] of Object.entries({ ...cells, B2: '398', ...added })) {
    await expect(again.getByRole('textbox', { name: `Case ${cell}`, exact: true })).toHaveValue(
      value,
    )
  }
  await again.getByRole('button', { name: 'Annuler', exact: true }).click()
  expect((await compile(page)).status).toBe('success')
  await expectPdfText(page, 'Conductivités mesurées', 'Aluminium', '398')
})

test('table generator: spreadsheet paste, CSV file and merged cells', async ({ accounts }) => {
  const { page } = await accounts.create()
  await importProject(page, 'Tableau importé', [{ path: 'main.tex', data: MAIN }])
  await cursorAtEndOf(page, 'Comme l’a montré Knuth')
  await runTool(page, 'structures', 'structures.table')
  const dialog = page.getByRole('dialog', { name: 'Nouveau tableau' })
  const cell = (name: string) => dialog.getByRole('textbox', { name: `Case ${name}`, exact: true })
  const preview = dialog.locator('pre')

  await test.step('cells pasted from a spreadsheet (tab-separated)', async () => {
    await dialog.getByRole('button', { name: 'Coller des données (tableur, CSV)' }).click()
    await dialog
      .getByLabel('Données à importer (tableur ou CSV, séparateur détecté)')
      .fill('Matériau\tConductivité\tÉcart\nCuivre\t401\t1,2\nAcier\t50\t4,1')
    await dialog.getByRole('button', { name: 'Remplacer la grille' }).click()
    await expect(cell('A1')).toHaveValue('Matériau')
    await expect(cell('C3')).toHaveValue('4,1')
  })

  await test.step('cells imported from a CSV file', async () => {
    await dialog.locator('input[type="file"]').setInputFiles({
      name: 'mesures.csv',
      mimeType: 'text/csv',
      buffer: Buffer.from('Métal;Masse;Volume\nFer;7,87;1\nOr;19,3;1\nZinc;7,14;1\n', 'utf8'),
    })
    await expect(cell('A1')).toHaveValue('Métal')
    await expect(cell('B2')).toHaveValue('7,87')
    await expect(cell('A4')).toHaveValue('Zinc')
  })

  await test.step('cells merged across columns and rows', async () => {
    await cell('A1').click()
    await cell('B1').click({ modifiers: ['Shift'] })
    await dialog.getByRole('button', { name: 'Fusionner les cases sélectionnées' }).click()
    await expect(preview).toContainText('\\multicolumn{2}')
    await cell('C2').click()
    await cell('C3').click({ modifiers: ['Shift'] })
    await dialog.getByRole('button', { name: 'Fusionner les cases sélectionnées' }).click()
    await expect(preview).toContainText('\\multirow{2}')
  })

  await dialog.getByRole('button', { name: 'Insérer', exact: true }).click()
  await expect(dialog).toBeHidden()
  await waitSynced(page)
  const text = await editorText(page)
  expect(text).toContain('\\usepackage{multirow}')
  expect(text).toContain('\\multicolumn{2}')
  expect(text).toContain('\\multirow{2}')
  expect((await compile(page)).status).toBe('success')
  await expectPdfText(page, 'Zinc')
})

test('package manager: search, add to the preamble, remove', async ({ accounts }) => {
  const { page } = await accounts.create()
  await importProject(page, 'Packages', [{ path: 'main.tex', data: MAIN }])

  await runTool(page, 'packages', 'packages.manager')
  const dialog = page.getByTestId('package-manager')
  await dialog.getByTestId('package-search').fill('booktabs')
  await dialog.locator('[data-package="booktabs"]').click()
  await dialog.getByTestId('package-add').click()
  await expect.poll(async () => editorText(page)).toContain('\\usepackage{booktabs}')

  await dialog.getByTestId('package-tab-project').click()
  const row = dialog.locator('[data-package-row="booktabs"]')
  await expect(row).toBeVisible()
  await row.getByTestId('package-remove').click()
  await expect(row).toHaveCount(0)
  await expect.poll(async () => editorText(page)).not.toContain('\\usepackage{booktabs}')
})

test('a misspelled package: close names in the logs, fixed in one click', async ({ accounts }) => {
  const { page } = await accounts.create()
  await importProject(page, 'Package mal écrit', [
    {
      path: 'main.tex',
      data: MAIN.replace('\\begin{document}', '\\usepackage{amsmth}\n\\begin{document}'),
    },
  ])
  const failed = await compile(page)
  expect(failed.status).toBe('failure')
  await page.getByTestId('panel-logs').click()
  const hint = page.getByTestId('missing-package').first()
  const fix = hint.getByRole('button', { name: 'Remplacer amsmth par amsmath' })
  await expect(fix).toBeVisible()
  await fix.click()
  await expect(hint.getByRole('status')).toHaveText(
    'amsmth remplacé par amsmath. Recompilez pour vérifier.',
  )
  await waitSynced(page)
  expect(await editorText(page)).toContain('\\usepackage{amsmath}')
  expect((await compile(page)).status).toBe('success')
})

test('word count from the status bar: totals, captions and sections', async ({ accounts }) => {
  const { page } = await accounts.create()
  await importProject(page, 'Compteur', [
    {
      path: 'main.tex',
      data: [
        '\\documentclass{article}',
        '\\begin{document}',
        '\\section{Introduction}',
        'Un deux trois quatre cinq six sept.',
        '\\section{Conclusion}',
        'Huit neuf dix.',
        '\\begin{figure}',
        '\\centering',
        '\\caption{Courbe de mesure}',
        '\\end{figure}',
        '\\end{document}',
        '',
      ].join('\n'),
    },
  ])
  await page.getByTestId('status-word-count').click()
  const dialog = page.getByTestId('word-count')
  const tile = (label: string) =>
    dialog
      .getByTestId('word-count-total')
      .locator('div')
      .filter({ has: page.getByText(label, { exact: true }) })
      .locator('dd')
  // Texte 7 + 3, titres 1 + 1, légende 3 : total 15.
  await expect(tile('Texte')).toHaveText('10')
  await expect(tile('Titres')).toHaveText('2')
  await expect(tile('Légendes')).toHaveText('3')
  await expect(tile('Total')).toHaveText('15')

  // Détail par section : colonnes Total, Texte, Titres, Légendes (pas de ligne « début du
  // document » : aucun mot avant le premier titre).
  const table = dialog.getByRole('table', { name: 'Détail par section' })
  const section = (title: string) =>
    table
      .locator('tbody tr')
      .filter({ has: page.getByRole('rowheader', { name: title, exact: true }) })
  await expect(table.locator('tbody tr')).toHaveCount(2)
  await expect(section('Introduction').getByRole('cell')).toHaveText(['8', '7', '1', '0'])
  await expect(section('Conclusion').getByRole('cell')).toHaveText(['7', '3', '1', '3'])
})

/** Couleur calculée du premier élément de `locator` (coloration syntaxique). */
async function colorOf(locator: Locator): Promise<string> {
  return locator.first().evaluate((element) => getComputedStyle(element).color)
}

/** Préférences `editor` et thème du compte, lus dans l'API. */
async function savedPreferences(page: Page) {
  const { preferences } = await api<{
    preferences: {
      theme: string
      editor: {
        fontFamily: string
        fontSize: number
        lineHeight: number
        keymap: string
        wrap: boolean
        spellcheck: boolean
        syntaxTheme: string
      }
    }
  }>(page, 'GET', '/me/preferences')
  return preferences
}

test('editor settings are applied at once, kept after a reload and on another device', async ({
  accounts,
}) => {
  const account = await accounts.create()
  const { page } = account
  const projectId = await importProject(page, 'Paramètres', [{ path: 'main.tex', data: MAIN }])
  const dialog = page.getByTestId('settings-dialog')
  const html = page.locator('html')
  // Commande `\documentclass` de la première ligne, colorée par le thème de coloration.
  const command = editorLine(page, '\\documentclass')
    .locator('span')
    .filter({
      hasText: /^\\documentclass$/,
    })
  const flagged = page.locator('.cm-content .cm-spellError')

  await test.step('light theme: applied at once, saved in the account and the cookie', async () => {
    await expect(html).toHaveAttribute('data-theme', 'dark')
    await page.getByTestId('status-settings').click()
    const theme = dialog.getByRole('radiogroup', { name: 'Thème de l’interface' })
    await expect(theme.getByRole('radio', { name: 'Sombre', exact: true })).toHaveAttribute(
      'aria-checked',
      'true',
    )
    await theme.getByRole('radio', { name: 'Clair', exact: true }).click()
    await expect(html).toHaveAttribute('data-theme', 'light')
    // L'éditeur suit le thème (variables de @kaxolax/ui sous `data-theme`).
    await expect(page.locator('.cm-editor')).toHaveAttribute('data-theme', 'light')
    await expect.poll(async () => (await savedPreferences(page)).theme).toBe('light')
    const cookies = await account.context.cookies()
    expect(cookies.find((cookie) => cookie.name === 'kaxolax-theme')?.value).toBe('light')
  })

  await test.step('syntax theme, font, size, line height, keymap and wrapping', async () => {
    const before = await colorOf(command)
    await dialog.getByTestId('settings-syntax-theme').selectOption('monokai')
    await expect.poll(() => colorOf(command)).not.toBe(before)
    await dialog.getByTestId('settings-font').selectOption('jetbrains-mono')
    await dialog.getByTestId('settings-font-size').selectOption('18')
    await dialog.getByLabel('Hauteur de ligne', { exact: true }).selectOption('2')
    await expect(page.locator('.cm-scroller')).toHaveCSS('font-family', /JetBrains Mono/)
    await expect(page.locator('.cm-content')).toHaveCSS('font-size', '18px')
    // Hauteur de ligne 2 en police de 18 px.
    await expect(page.locator('.cm-scroller')).toHaveCSS('line-height', '36px')
    // Vim, puis Emacs : le mode actif est affiché dans la barre d'état.
    const keymap = dialog.getByTestId('settings-keymap')
    await keymap.selectOption('vim')
    await expect(page.getByTestId('editor-status-bar')).toContainText('Vim')
    await keymap.selectOption('emacs')
    await expect(page.getByTestId('editor-status-bar')).toContainText('Emacs')
    await expect(page.getByTestId('editor-status-bar')).not.toContainText('Vim')
    await dialog.getByTestId('settings-wrap').click()
    await expect(dialog.getByTestId('settings-wrap')).toHaveAttribute('aria-checked', 'false')
    await expect(page.locator('.cm-content')).not.toHaveClass(/cm-lineWrapping/)
  })

  await test.step('spellchecker turned off: no word is underlined any more', async () => {
    // Projet neuf relu en anglais : les mots français du document sont soulignés.
    await expect.poll(() => flagged.count()).toBeGreaterThan(0)
    await dialog.getByRole('tab', { name: 'Correcteur', exact: true }).click()
    const spellcheck = dialog.getByTestId('settings-spellcheck')
    await expect(spellcheck).toHaveAttribute('aria-checked', 'true')
    await spellcheck.click()
    await expect(spellcheck).toHaveAttribute('aria-checked', 'false')
    await expect(flagged).toHaveCount(0)
    await page.keyboard.press('Escape')
    await expect(dialog).toBeHidden()
    await expect(page.getByTestId('status-spellcheck')).toHaveAccessibleName(
      'Correcteur orthographique : désactivé',
    )
  })

  // Enregistrés dans le compte (envoi groupé des préférences).
  await expect
    .poll(async () => (await savedPreferences(page)).editor)
    .toMatchObject({
      syntaxTheme: 'monokai',
      fontFamily: 'jetbrains-mono',
      fontSize: 18,
      lineHeight: 2,
      keymap: 'emacs',
      wrap: false,
      spellcheck: false,
    })

  await test.step('kept after a reload', async () => {
    await page.reload()
    // Thème rendu dès le HTML (cookie), sans attendre les préférences.
    await expect(html).toHaveAttribute('data-theme', 'light')
    await waitForEditor(page)
    await expect(page.getByTestId('editor-status-bar')).toContainText('Emacs')
    await expect(page.locator('.cm-content')).toHaveCSS('font-size', '18px')
    await expect(page.locator('.cm-scroller')).toHaveCSS('line-height', '36px')
    await expect(page.locator('.cm-scroller')).toHaveCSS('font-family', /JetBrains Mono/)
    await expect(flagged).toHaveCount(0)
    await page.getByTestId('status-settings').click()
    await expect(dialog.getByRole('radio', { name: 'Clair', exact: true })).toHaveAttribute(
      'aria-checked',
      'true',
    )
    await expect(dialog.getByTestId('settings-syntax-theme')).toHaveValue('monokai')
    await expect(dialog.getByTestId('settings-font')).toHaveValue('jetbrains-mono')
    await expect(dialog.getByTestId('settings-font-size')).toHaveValue('18')
    await expect(dialog.getByLabel('Hauteur de ligne', { exact: true })).toHaveValue('2')
    await expect(dialog.getByTestId('settings-keymap')).toHaveValue('emacs')
    await expect(dialog.getByTestId('settings-wrap')).toHaveAttribute('aria-checked', 'false')
    await dialog.getByRole('tab', { name: 'Correcteur', exact: true }).click()
    await expect(dialog.getByTestId('settings-spellcheck')).toHaveAttribute('aria-checked', 'false')
    await page.keyboard.press('Escape')
  })

  await test.step('the same settings on another device', async () => {
    // Nouvelle session, sans cookie de thème, autre taille d'écran.
    const other = await accounts.session(account, { viewport: { width: 1280, height: 800 } })
    await openProject(other, projectId)
    await expect(other.locator('html')).toHaveAttribute('data-theme', 'light')
    await expect(other.getByTestId('editor-status-bar')).toContainText('Emacs')
    await expect(other.locator('.cm-content')).toHaveCSS('font-size', '18px')
    await expect(other.locator('.cm-scroller')).toHaveCSS('line-height', '36px')
    await expect(other.getByTestId('status-spellcheck')).toHaveAccessibleName(
      'Correcteur orthographique : désactivé',
    )
  })

  await test.step('back to the defaults: dark theme and default shortcuts', async () => {
    await page.getByTestId('status-settings').click()
    await dialog.getByRole('tab', { name: 'Éditeur', exact: true }).click()
    await dialog.getByRole('radio', { name: 'Sombre', exact: true }).click()
    await expect(html).toHaveAttribute('data-theme', 'dark')
    await dialog.getByTestId('settings-keymap').selectOption('default')
    await expect(page.getByTestId('editor-status-bar')).not.toContainText('Emacs')
    await page.keyboard.press('Escape')
    await expect
      .poll(async () => {
        const preferences = await savedPreferences(page)
        return [preferences.theme, preferences.editor.keymap]
      })
      .toEqual(['dark', 'default'])
  })
})

/**
 * Délai de frappe de CodeMirror avant de demander les propositions (`activateOnTypingDelay` de
 * @codemirror/autocomplete, 100 ms par défaut) : il s'ajoute au temps de la source, mesuré ici.
 */
const TYPING_DELAY_MS = 100
/** Temps de réponse visé pour les clés de citation (spécification de l'étape 2). */
const CITATION_BUDGET_MS = 100

/** Attend la liste d'autocomplétion avec `expected` (redemandée si l'index se chargeait). */
async function expectCompletion(page: Page, expected: string): Promise<void> {
  const tooltip = page.locator('.cm-tooltip-autocomplete')
  await expect(async () => {
    if (!(await tooltip.isVisible())) await page.keyboard.press('Control+Space')
    await expect(tooltip).toContainText(expected, { timeout: 2_000 })
  }).toPass({ timeout: 30_000 })
}

/**
 * Tape `typed` et mesure, dans la page, le temps entre la dernière touche et l'affichage d'une
 * liste d'autocomplétion qui contient `expected`.
 */
async function completionDelay(page: Page, typed: string, expected: string): Promise<number> {
  const last = typed.at(-1) ?? ''
  const measured = page.evaluate(
    ({ key, text }) =>
      new Promise<number>((resolve, reject) => {
        let start = 0
        const onKey = (event: KeyboardEvent) => {
          if (event.key === key) start = performance.now()
        }
        const observer = new MutationObserver(() => {
          const tooltip = document.querySelector('.cm-tooltip-autocomplete')
          if (start > 0 && tooltip?.textContent.includes(text) === true) {
            observer.disconnect()
            document.removeEventListener('keydown', onKey, true)
            resolve(performance.now() - start)
          }
        })
        document.addEventListener('keydown', onKey, true)
        observer.observe(document.body, { childList: true, subtree: true, characterData: true })
        setTimeout(() => {
          observer.disconnect()
          reject(new Error(`no completion with ${text}`))
        }, 5_000)
      }),
    { key: last, text: expected },
  )
  await page.keyboard.type(typed)
  return measured
}

test('citation keys are completed after \\cite{ in less than 100 ms', async ({ accounts }) => {
  const { page } = await accounts.create()
  await importProject(page, 'Autocomplétion', [
    { path: 'main.tex', data: MAIN },
    { path: 'refs.bib', data: REFS_BIB },
  ])
  await cursorAtEndOf(page, 'Comme l’a montré Knuth')
  await page.keyboard.type('~\\cite{')
  // L'index du projet (clés des .bib) se charge à l'ouverture : la liste est redemandée au besoin.
  await expectCompletion(page, 'knuth')
  await page.keyboard.press('Enter')
  await waitSynced(page)
  expect(await editorText(page)).toContain('Comme l’a montré Knuth~\\cite{knuth}')

  // Index chargé : la liste suit la frappe dans le budget (délai de frappe de CodeMirror en plus).
  await cursorAtEndOf(page, 'Comme l’a montré Knuth')
  const delay = await completionDelay(page, ' et \\cite{', 'knuth')
  expect(delay).toBeLessThan(TYPING_DELAY_MS + CITATION_BUDGET_MS)
  await page.keyboard.press('Escape')
})

test('labels, commands of the loaded packages and file paths are completed', async ({
  accounts,
}) => {
  const { page } = await accounts.create()
  await importProject(page, 'Propositions', [
    {
      path: 'main.tex',
      data: [
        '\\documentclass{article}',
        '\\usepackage{amsmath}',
        '\\usepackage{booktabs}',
        '\\usepackage{graphicx}',
        '\\begin{document}',
        '\\section{Introduction}',
        '\\label{sec:intro}',
        '\\begin{equation}',
        '  e^{i\\pi} + 1 = 0',
        '  \\label{eq:euler}',
        '\\end{equation}',
        'Références :',
        '\\end{document}',
        '',
      ].join('\n'),
    },
    { path: 'sections/annexe.tex', data: 'Annexe.\n' },
    { path: 'figures/courbe.png', data: PLOT_PNG },
  ])
  const tooltip = page.locator('.cm-tooltip-autocomplete')
  /** Nouvelle ligne après « Références : », puis frappe de `typed`. */
  const typeOnNewLine = async (typed: string) => {
    await cursorAtEndOf(page, 'Références :')
    await page.keyboard.press('Enter')
    await page.keyboard.type(typed)
  }

  await test.step('\\ref and \\eqref propose the labels of the project', async () => {
    await typeOnNewLine('\\ref{')
    await expectCompletion(page, 'sec:intro')
    await expect(tooltip).toContainText('eq:euler')
    await page.keyboard.press('Escape')
    await typeOnNewLine('\\eqref{')
    await expectCompletion(page, 'eq:euler')
    await page.keyboard.press('Enter')
    await waitSynced(page)
    expect(await editorText(page)).toContain('\\eqref{eq:euler}')
  })

  await test.step('commands of the loaded packages are proposed, not the others', async () => {
    await typeOnNewLine('\\toprul')
    await expectCompletion(page, '\\toprule')
    await page.keyboard.press('Escape')
    // multirow n'est pas chargé : sa commande n'est pas proposée.
    await typeOnNewLine('\\multiro')
    await page.keyboard.press('Control+Space')
    await expect(tooltip.filter({ hasText: '\\multirow' })).toHaveCount(0)
    await page.keyboard.press('Escape')
  })

  await test.step('\\input and \\includegraphics propose the files of the project', async () => {
    await typeOnNewLine('\\input{')
    await expectCompletion(page, 'sections/annexe')
    await page.keyboard.press('Escape')
    await typeOnNewLine('\\includegraphics{')
    await expectCompletion(page, 'figures/courbe.png')
    await page.keyboard.press('Enter')
    await waitSynced(page)
    expect(await editorText(page)).toContain('\\includegraphics{figures/courbe.png}')
  })
})
