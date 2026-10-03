import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AssignableRole, BuildState, CompileResult, ShareLinkKind } from '@kaxolax/contracts'
import { expect, type Locator, type Page, type Response } from '@playwright/test'
import type { Account } from './accounts'
import { api } from './api'
import { buildZip, type ProjectFile } from './files'
import { searchQueryFor } from './search-query'

/** Fichiers statiques des parcours (image, bibliographie). */
export const FIXTURES = join(import.meta.dirname, 'fixtures')
export const PLOT_PNG = readFileSync(join(FIXTURES, 'plot.png'))
export const REFS_BIB = readFileSync(join(FIXTURES, 'refs.bib'), 'utf8')

const PROJECT_PATH = /\/project\/([0-9a-f-]{36})$/
/** Attente maximale d'une compilation suivie (asynchrone : réveil du conteneur compris). */
const BUILD_TIMEOUT_MS = 180_000

/** Identifiant du projet ouvert dans la page. */
export function projectIdOf(page: Page): string {
  const id = PROJECT_PATH.exec(new URL(page.url()).pathname)?.[1]
  if (id === undefined) throw new Error(`not on a project page: ${page.url()}`)
  return id
}

/** Attend l'éditeur du document ouvert, synchronisé avec le serveur. */
export async function waitForEditor(page: Page): Promise<void> {
  await expect(page.locator('.cm-content')).toBeVisible()
  await waitSynced(page)
}

/** Dernières frappes arrivées au serveur (indicateur « Enregistré » de l'onglet). */
export async function waitSynced(page: Page): Promise<void> {
  await expect(page.getByTestId('sync-state')).toHaveText('Enregistré')
}

/**
 * Crée un projet par l'import zip du tableau de bord (nom du zip = nom du projet) et attend
 * l'éditeur ; renvoie l'id du projet.
 */
export async function importProject(
  page: Page,
  name: string,
  files: readonly ProjectFile[],
): Promise<string> {
  if (!new URL(page.url()).pathname.endsWith('/dashboard')) await page.goto('/dashboard')
  // Liste chargée : la page est hydratée, l'input d'import a son gestionnaire.
  await expect(
    page.getByTestId('project-row').first().or(page.getByText('Aucun projet pour l’instant')),
  ).toBeVisible()
  await page.getByTestId('import-input').setInputFiles({
    name: `${name}.zip`,
    mimeType: 'application/zip',
    buffer: buildZip(files),
  })
  await expect(page).toHaveURL(PROJECT_PATH)
  await waitForEditor(page)
  return projectIdOf(page)
}

/** Ouvre un projet et attend son éditeur. */
export async function openProject(page: Page, projectId: string): Promise<void> {
  await page.goto(`/project/${projectId}`)
  await waitForEditor(page)
}

/** Ouvre un fichier de l'arborescence et attend son éditeur (ou son aperçu). */
export async function openInTree(page: Page, path: string): Promise<void> {
  await page.locator(`[data-path="${path}"]`).click()
  await expect(activeTab(page)).toHaveAttribute('data-tab-path', path)
  if (/\.(?:tex|bib|sty|cls|txt)$/.test(path)) await waitForEditor(page)
}

/** Onglet actif de l'éditeur. */
export function activeTab(page: Page): Locator {
  return page.locator('[data-testid="editor-tab"][aria-selected="true"]')
}

/** Remplace tout le texte du document ouvert, en une seule insertion (pas d'accolade ajoutée). */
export async function replaceEditorContent(page: Page, text: string): Promise<void> {
  const content = page.locator('.cm-content')
  await content.click()
  await page.keyboard.press('ControlOrMeta+A')
  await page.keyboard.press('Delete')
  await page.keyboard.insertText(text)
  await waitSynced(page)
}

/** Ajoute du texte à la fin du document ouvert. */
export async function appendToEditor(page: Page, text: string): Promise<void> {
  await page.locator('.cm-content').click()
  await page.keyboard.press('ControlOrMeta+End')
  await page.keyboard.insertText(text)
  await waitSynced(page)
}

/** Ajoute du texte au début du document ouvert. */
export async function prependToEditor(page: Page, text: string): Promise<void> {
  await page.locator('.cm-content').click()
  await page.keyboard.press('ControlOrMeta+Home')
  await page.keyboard.insertText(text)
  await waitSynced(page)
}

/** Ligne de l'éditeur qui contient `text`. */
export function editorLine(page: Page, text: string): Locator {
  return page.locator('.cm-content .cm-line', { hasText: text }).first()
}

/** Place le curseur sur la ligne qui contient `text` (au début de son texte). */
export async function placeCursorOn(page: Page, text: string): Promise<void> {
  await editorLine(page, text).click({ position: { x: 8, y: 6 } })
}

/** Sélectionne au clavier toute la ligne qui contient `text` (éditeur modifiable). */
export async function selectLine(page: Page, text: string): Promise<void> {
  await placeCursorOn(page, text)
  await page.keyboard.press('Home')
  await page.keyboard.press('Shift+End')
}

/**
 * Sélectionne la première occurrence de `text` par la recherche de l'éditeur (Tools → Rechercher
 * dans le fichier, Entrée, Échap) : indépendant du retour à la ligne, possible en lecture seule.
 * Recherche non littérale : antislashs doublés par `searchQueryFor`. Une occurrence doit être
 * trouvée (sélectionnée), sinon le parcours échoue ici plutôt que sur une sélection vide.
 */
export async function selectText(page: Page, text: string): Promise<void> {
  await runTool(page, 'search', 'search.find')
  const field = page.locator('.cm-search input[name="search"]')
  await field.fill(searchQueryFor(text))
  await field.press('Enter')
  await expect(page.locator('.cm-content .cm-searchMatch-selected').first()).toBeVisible()
  await field.press('Escape')
  await expect(page.locator('.cm-search')).toHaveCount(0)
}

/** Place le curseur juste après la première occurrence de `text` (retour à la ligne indifférent). */
export async function placeCursorAfter(page: Page, text: string): Promise<void> {
  await selectText(page, text)
  // Flèche droite sur une sélection : curseur à sa fin.
  await page.keyboard.press('ArrowRight')
}

/**
 * Texte du document ouvert, ligne par ligne, sans les curseurs des collaborateurs (widgets) ;
 * les documents des parcours sont courts : toutes leurs lignes sont rendues.
 */
export async function editorText(page: Page): Promise<string> {
  return page.locator('.cm-content').evaluate((content) =>
    Array.from(content.querySelectorAll(':scope > .cm-line'))
      .map((line) => {
        const copy = line.cloneNode(true) as HTMLElement
        for (const widget of copy.querySelectorAll(
          '.cm-ySelectionCaret, .cm-widgetBuffer, [contenteditable="false"]',
        )) {
          widget.remove()
        }
        return copy.textContent
      })
      .join('\n'),
  )
}

/** Numéro de la ligne du curseur (gouttière). */
export async function activeLine(page: Page): Promise<string> {
  return (await page.locator('.cm-activeLineGutter').first().textContent()) ?? ''
}

// --- Compilation --------------------------------------------------------------------------------

/** Pastille de statut de la compilation (`data-status` : compiling, success, errors…). */
export function compileStatus(page: Page): Locator {
  return page.locator('[data-status]', { has: page.getByTestId('recompile') })
}

function isCompileRequest(response: Response): boolean {
  return (
    new URL(response.url()).pathname.endsWith('/compile') && response.request().method() === 'POST'
  )
}

/**
 * Suit une demande de compilation jusqu'à son résultat, dans les deux modes de l'API : réponse
 * synchrone (`gateway`) qui porte le résultat ; 202 `{ buildId, status }` (`cloudflare`) dont
 * l'interface suit l'état (pastille) jusqu'à un état final, le résultat étant relu par
 * `GET /projects/:id/builds/:buildId` ; 409 `E_COMPILE_IN_PROGRESS` : l'interface relance à la fin
 * de la compilation en cours, et cette relance est suivie à son tour.
 */
async function followCompile(page: Page, response: Response): Promise<CompileResult> {
  const body = (await response.json()) as unknown
  if (response.status() === 200) return body as CompileResult
  const accepted = body as { buildId?: unknown; code?: unknown }
  if (response.status() === 409 && accepted.code === 'E_COMPILE_IN_PROGRESS') {
    const relaunched = await page.waitForResponse(isCompileRequest, { timeout: BUILD_TIMEOUT_MS })
    return followCompile(page, relaunched)
  }
  if (response.status() !== 202 || typeof accepted.buildId !== 'string') {
    throw new Error(`compile answered ${String(response.status())}: ${JSON.stringify(body)}`)
  }
  // Pastille « Préparation du compilateur… », « En attente… » puis « Compilation… » : en cours
  // depuis le clic, finale quand l'interface a reçu le résultat (événement ou sondage).
  await expect(compileStatus(page)).not.toHaveAttribute('data-status', 'compiling', {
    timeout: BUILD_TIMEOUT_MS,
  })
  const { build } = await api<{ build: BuildState }>(
    page,
    'GET',
    `/projects/${projectIdOf(page)}/builds/${accepted.buildId}`,
  )
  if (build.result === null) throw new Error(`build ${accepted.buildId} ended without a result`)
  return build.result
}

/**
 * Lance une compilation (pastille de statut, ou autre bouton `trigger` : « Compiler » d'un projet
 * jamais compilé) et attend son résultat, quel que soit le mode.
 */
export async function compile(page: Page, trigger?: Locator): Promise<CompileResult> {
  const requested = page.waitForResponse(isCompileRequest)
  await (trigger ?? page.getByTestId('recompile')).click()
  return followCompile(page, await requested)
}

/** Choisit le compilateur dans le menu de la pastille de statut et attend son enregistrement. */
export async function chooseCompiler(page: Page, label: string): Promise<void> {
  await page.getByTestId('compile-menu').click()
  const item = page.getByRole('menuitemradio', { name: label })
  if ((await item.getAttribute('aria-checked')) === 'true') {
    await page.keyboard.press('Escape')
    return
  }
  const saved = page.waitForResponse(
    (candidate) =>
      /\/projects\/[0-9a-f-]{36}$/.test(new URL(candidate.url()).pathname) &&
      candidate.request().method() === 'PATCH',
  )
  await item.click()
  expect((await saved).ok()).toBe(true)
}

/** Textes attendus dans le PDF affiché (couches texte de pdf.js). */
export async function expectPdfText(page: Page, ...texts: string[]): Promise<void> {
  // Le tiroir des logs recouvre le haut du PDF : il est refermé.
  const closeLogs = page.getByTestId('close-logs')
  if (await closeLogs.isVisible()) await closeLogs.click()
  const viewer = page.getByTestId('pdf-viewer')
  for (const text of texts) await expect(viewer).toContainText(text)
}

// --- Outils, partage ----------------------------------------------------------------------------

/** Lance une action de la barre Tools (menu `data-menu`, action `data-action`). */
export async function runTool(page: Page, menu: string, action: string): Promise<void> {
  const bar = page.getByTestId('tools-bar')
  if (!(await bar.isVisible())) await page.getByTestId('tools-toggle').click()
  await bar.locator(`[data-menu="${menu}"]`).click()
  await page.locator(`[data-action="${action}"]`).click()
}

/** Ouvre la modale de partage du projet ouvert. */
export async function openShareDialog(page: Page): Promise<Locator> {
  await page.getByTestId('share-button').click()
  const dialog = page.getByTestId('share-dialog')
  await expect(dialog).toBeVisible()
  return dialog
}

/** Active un lien de partage par l'API et renvoie son adresse. */
export async function enableShareLink(
  owner: Page,
  projectId: string,
  kind: ShareLinkKind,
): Promise<string> {
  const { link } = await api<{ link: { url: string | null } }>(
    owner,
    'PUT',
    `/projects/${projectId}/share-links/${kind}`,
    { enabled: true },
  )
  if (link.url === null) throw new Error(`the ${kind} share link has no URL`)
  return link.url
}

/** Jeton d'une adresse de lien de partage (`…/share/<jeton>`). */
export function shareToken(url: string): string {
  const token = /\/share\/([A-Za-z0-9_-]+)$/.exec(url)?.[1]
  if (token === undefined) throw new Error(`not a share link: ${url}`)
  return token
}

/**
 * Ajoute un membre au projet sans passer par l'interface du partage (préparation d'un parcours) :
 * lien d'édition activé, rejoint par le membre, désactivé, puis rôle changé au besoin.
 */
export async function addMember(
  owner: Account,
  member: Account,
  projectId: string,
  role: AssignableRole,
): Promise<void> {
  const url = await enableShareLink(owner.page, projectId, 'edit')
  await api(member.page, 'POST', `/share/${shareToken(url)}/join`)
  await api(owner.page, 'PUT', `/projects/${projectId}/share-links/edit`, { enabled: false })
  if (role !== 'editor') {
    await api(owner.page, 'PATCH', `/projects/${projectId}/members/${member.id}`, { role })
  }
}

// --- Chat, commentaires -------------------------------------------------------------------------

/** Affiche l'onglet Chats de la sidebar. */
export async function openChat(page: Page): Promise<Locator> {
  await page.getByRole('tab', { name: /^Chats/ }).click()
  const panel = page.getByTestId('chat-panel')
  await expect(page.getByTestId('chat-input')).toBeEnabled()
  return panel
}

/** Envoie un message du chat (Entrée) ; le chat doit être affiché. */
export async function sendChat(page: Page, text: string): Promise<void> {
  const input = page.getByTestId('chat-input')
  await input.fill(text)
  await input.press('Enter')
  await expect(input).toHaveValue('')
}

/** Message du chat qui contient `text`. */
export function chatMessage(page: Page, text: string): Locator {
  return page.getByTestId('chat-message').filter({ hasText: text })
}

/** Ouvre le panneau Review (commentaires) s'il ne l'est pas. */
export async function openReview(page: Page): Promise<Locator> {
  const panel = page.getByTestId('review-panel')
  if (!(await panel.isVisible())) await page.getByTestId('review-toggle').click()
  await expect(panel).toBeVisible()
  return panel
}

/** Fil de commentaires du panneau Review qui contient `text`. */
export function commentThread(page: Page, text: string): Locator {
  return page.getByTestId('comment-thread').filter({ hasText: text })
}

/** Commente le texte sélectionné dans l'éditeur ; renvoie le fil créé. */
export async function commentSelection(page: Page, body: string): Promise<Locator> {
  const panel = await openReview(page)
  await panel.getByTestId('comment-selection').click()
  const draft = panel.getByTestId('comment-draft')
  await draft.getByTestId('comment-input').fill(body)
  await draft.getByTestId('comment-submit').click()
  await expect(draft).toBeHidden()
  const thread = commentThread(page, body)
  await expect(thread).toBeVisible()
  return thread
}

/** Texte surligné par les fils ouverts dans l'éditeur (marques éventuellement découpées). */
export async function commentedText(page: Page): Promise<string> {
  return (await page.locator('.cm-content .cm-comment-highlight').allTextContents()).join('')
}

// --- Suivi des modifications ------------------------------------------------------------------

/** Ouvre le panneau Review sur la section Suggestions. */
export async function openSuggestions(page: Page): Promise<Locator> {
  const panel = await openReview(page)
  await panel.getByTestId('review-suggestions-tab').click()
  return panel
}

/** Carte de la section Suggestions qui contient `text` (texte d'origine ou proposé). */
export function suggestionCard(page: Page, text: string): Locator {
  return page.getByTestId('suggestion-card').filter({ hasText: text })
}

/** Bascule Modifier / Suggérer de la barre de l'éditeur (éditeur ou propriétaire). */
export async function setEditMode(page: Page, mode: 'edit' | 'suggest'): Promise<void> {
  const item = page.getByTestId(mode === 'edit' ? 'edit-mode-edit' : 'edit-mode-suggest')
  if ((await item.getAttribute('data-state')) !== 'on') await item.click()
  await expect(item).toHaveAttribute('data-state', 'on')
}

/** Texte ajouté affiché en ligne par les suggestions (widgets), dans l'ordre du document. */
export async function suggestedText(page: Page): Promise<string> {
  return (await page.locator('.cm-content .cm-suggestion-insert').allTextContents()).join('')
}

/** Texte barré par les suggestions (suppressions et remplacements). */
export async function struckText(page: Page): Promise<string> {
  return (await page.locator('.cm-content .cm-suggestion-delete').allTextContents()).join('')
}
