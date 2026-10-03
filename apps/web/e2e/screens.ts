import { mkdir, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * Captures d'écran (`screenshots.spec.ts`, projet Playwright `screenshots`) : liste des écrans,
 * noms de fichiers stables et index Markdown. Dossier ignoré par git.
 */
export const SCREENSHOT_DIR = join(import.meta.dirname, 'screenshots')

export const THEMES = ['dark', 'light'] as const
export type ScreenTheme = (typeof THEMES)[number]

export interface ScreenViewport {
  /** Nom dans les fichiers : `1440x900`. */
  name: string
  width: number
  height: number
  /** Écran étroit (mise en page mobile : tiroir de la sidebar, onglets Éditeur / PDF). */
  mobile: boolean
}

export const VIEWPORTS: readonly ScreenViewport[] = [
  { name: '1440x900', width: 1440, height: 900, mobile: false },
  { name: '390x844', width: 390, height: 844, mobile: true },
]

/** Écrans capturés, dans l'ordre de l'index (le préfixe numérote les fichiers). */
export const SCREENS = [
  { id: '00-sign-in', title: 'Connexion' },
  { id: '00-sign-up', title: 'Inscription' },
  { id: '01-dashboard', title: 'Tableau de bord' },
  { id: '01-new-from-template', title: 'Tableau de bord : nouveau projet depuis un template' },
  { id: '02-templates', title: 'Galerie de templates' },
  { id: '03-template-detail', title: 'Fiche d’un template' },
  { id: '04-project', title: 'Page projet : éditeur et PDF compilé' },
  { id: '04-banner', title: 'Page projet : bannière système active' },
  {
    id: '04-compile-menu',
    title: 'Pastille de compilation : auto-compilation, compilateur, brouillon',
  },
  { id: '04-pdf-zoom', title: 'PDF : menu du zoom' },
  { id: '04-pdf-more', title: 'PDF : menu ⋯ et fichiers de sortie' },
  { id: '05-project-pdf', title: 'Page projet : vue PDF (écran étroit)' },
  { id: '06-tools-file', title: 'Barre Tools : menu Fichier' },
  { id: '06-tools-format', title: 'Barre Tools : menu Format' },
  { id: '06-tools-structures', title: 'Barre Tools : menu Structures' },
  { id: '06-tools-math', title: 'Barre Tools : menu Maths' },
  { id: '06-tools-graphics', title: 'Barre Tools : menu Graphiques' },
  { id: '06-tools-packages', title: 'Barre Tools : menu Packages' },
  { id: '06-tools-search', title: 'Barre Tools : menu Rechercher' },
  { id: '06-tools-replace', title: 'Barre Tools : menu Remplacer' },
  { id: '07-outline', title: 'Plan du document' },
  { id: '08-search', title: 'Recherche dans le projet' },
  { id: '09-logs', title: 'Logs de compilation' },
  { id: '10-share', title: 'Partage' },
  { id: '10-plan-limit', title: 'Partage : limite de collaborateurs du plan atteinte' },
  { id: '10-join-link', title: 'Rejoindre un projet par un lien de partage' },
  { id: '10-join-invitation', title: 'Invitation à collaborer' },
  { id: '11-presence', title: 'Présence : curseur, nom et avatars du collaborateur' },
  { id: '12-chat', title: 'Chat du projet' },
  { id: '13-review', title: 'Panneau Review (commentaires)' },
  { id: '14-history-list', title: 'Historique : versions groupées par jour' },
  { id: '14-history-diff', title: 'Historique : diff par auteur' },
  { id: '15-formula', title: 'Éditeur de formules' },
  { id: '16-symbols', title: 'Symboles' },
  { id: '17-table', title: 'Tableau' },
  { id: '18-packages', title: 'Gestionnaire de packages' },
  { id: '19-word-count', title: 'Compteur de mots' },
  { id: '20-settings', title: 'Paramètres de l’éditeur' },
  { id: '20-spellcheck', title: 'Correcteur : menu du clic droit' },
  { id: '21-pricing', title: 'Tarifs' },
  { id: '22-account', title: 'Compte' },
  { id: '22-account-billing', title: 'Compte : facturation (Billing)' },
  { id: '23-admin-users', title: 'Admin : utilisateurs' },
  { id: '23-admin-user', title: 'Admin : fiche d’un utilisateur (bannir, révoquer, supprimer)' },
  { id: '24-admin-projects', title: 'Admin : projets' },
  {
    id: '24-admin-project',
    title: 'Admin : fiche d’un projet (transfert, archivage, corbeille)',
  },
  { id: '25-admin-banners', title: 'Admin : bannière système' },
  { id: '26-admin-stats', title: 'Admin : statistiques' },
  { id: '27-admin-audit-log', title: 'Admin : journal' },
  { id: '28-workspace-switcher', title: 'Équipes : sélecteur de workspace (personnel, équipes)' },
  { id: '28-team-dashboard', title: 'Équipes : projets de l’équipe, plan et stockage mutualisé' },
  { id: '28-team', title: 'Équipes : page de l’équipe (plan, usage, membres et invitations)' },
  { id: '28-team-new', title: 'Équipes : création d’une équipe' },
  { id: '29-admin-organizations', title: 'Admin : organisations' },
  { id: '29-admin-organization', title: 'Admin : fiche d’une organisation (membres, projets)' },
] as const

export type ScreenId = (typeof SCREENS)[number]['id']

const THEME_LABELS: Record<ScreenTheme, string> = { dark: 'Sombre', light: 'Clair' }

/** Nom stable d'une capture : `04-project--dark--1440x900.png`. */
export function screenshotName(id: ScreenId, theme: ScreenTheme, viewport: string): string {
  return `${id}--${theme}--${viewport}.png`
}

/** Écran, thème et taille d'un nom de capture ; null pour un autre fichier. */
export function parseScreenshotName(
  file: string,
): { id: ScreenId; theme: ScreenTheme; viewport: string } | null {
  const match = /^(.+)--(dark|light)--(\d+x\d+)\.png$/.exec(file)
  if (match === null) return null
  const [, id, theme, viewport] = match
  const screen = SCREENS.find((candidate) => candidate.id === id)
  const knownTheme = THEMES.find((candidate) => candidate === theme)
  if (screen === undefined || knownTheme === undefined || viewport === undefined) return null
  return { id: screen.id, theme: knownTheme, viewport }
}

/** Ordre des variantes : taille de la liste `VIEWPORTS`, puis sombre avant clair. */
function variantRank(theme: ScreenTheme, viewport: string): number {
  const size = VIEWPORTS.findIndex((candidate) => candidate.name === viewport)
  return (size === -1 ? VIEWPORTS.length : size) * THEMES.length + THEMES.indexOf(theme)
}

/**
 * Index Markdown des captures présentes : une section par écran (ordre de `SCREENS`), un lien
 * par variante. Format stable pour Prettier (titres, listes, lignes vides).
 */
export function renderScreenshotIndex(files: readonly string[], generatedAt: Date): string {
  const parsed = files
    .map((file) => ({ file, name: parseScreenshotName(file) }))
    .filter(
      (entry): entry is { file: string; name: NonNullable<typeof entry.name> } =>
        entry.name !== null,
    )
  const lines = [
    '# Captures d’écran de Kaxolax',
    '',
    `Générées le ${generatedAt.toISOString().slice(0, 16).replace('T', ' à ')} (UTC) par \`pnpm --filter @kaxolax/web screenshots\` : thèmes sombre et clair, écrans 1440×900 et 390×844 (l’admin n’a que le thème sombre). ${String(parsed.length)} captures.`,
    '',
  ]
  for (const screen of SCREENS) {
    const variants = parsed
      .filter((entry) => entry.name.id === screen.id)
      .sort(
        (a, b) =>
          variantRank(a.name.theme, a.name.viewport) - variantRank(b.name.theme, b.name.viewport),
      )
    lines.push(`## ${screen.title}`, '')
    if (variants.length === 0) {
      lines.push('Aucune capture.', '')
      continue
    }
    for (const { file, name } of variants) {
      lines.push(`- [${THEME_LABELS[name.theme]} · ${name.viewport.replace('x', '×')}](${file})`)
    }
    lines.push('')
  }
  return `${lines.join('\n').trimEnd()}\n`
}

/**
 * Prépare le dossier des captures pour un nouveau passage : les PNG et l'index d'un passage
 * précédent sont retirés (un écran en échec ou retiré de la liste ne garde pas d'ancienne image).
 */
export async function clearScreenshots(directory = SCREENSHOT_DIR): Promise<void> {
  await mkdir(directory, { recursive: true })
  for (const file of await readdir(directory)) {
    if (file.endsWith('.png') || file === 'index.md') await rm(join(directory, file))
  }
}

/** Écrit `index.md` dans le dossier des captures et renvoie son chemin. */
export async function writeScreenshotIndex(directory = SCREENSHOT_DIR): Promise<string> {
  const files = (await readdir(directory)).filter((file) => file.endsWith('.png')).sort()
  const path = join(directory, 'index.md')
  await writeFile(path, renderScreenshotIndex(files, new Date()))
  return path
}
