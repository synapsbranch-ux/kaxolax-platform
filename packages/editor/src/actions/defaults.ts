import { toggleComment } from '@codemirror/commands'
import {
  findNext,
  findPrevious,
  gotoLine,
  openSearchPanel,
  replaceAll,
  replaceNext,
} from '@codemirror/search'
import { EditorSelection, type StateCommand } from '@codemirror/state'
import type { EditorView } from '@codemirror/view'
import { planPackage } from '../packages.js'
import {
  type BlockTemplate,
  CURSOR,
  type EditBuilder,
  editCommand,
  inlineSnippet,
  insertBlock,
  type RequiredPackage,
  replaceWithBlock,
  toggleWrap,
} from './edit.js'
import { writingActions } from './writing.js'
import {
  type ActionContext,
  type ActionHost,
  type ActionRegistry,
  canEdit,
  createActionRegistry,
  type EditorAction,
  hasEditor,
  isReadOnly,
} from './registry.js'

/** Exécute une commande CodeMirror sur l'éditeur courant, puis lui rend le focus. */
function onView(command: (view: EditorView) => boolean) {
  return ({ view }: ActionContext) => {
    if (view === null) return false
    const done = command(view)
    view.focus()
    return done
  }
}

/** Action de modification du texte (désactivée en lecture seule), une étape d'annulation. */
function editAction(
  action: Omit<EditorAction, 'run' | 'when'>,
  build: EditBuilder,
  packages: readonly RequiredPackage[] = [],
): EditorAction {
  const command = editCommand(build, packages)
  return { ...action, when: canEdit, run: onView((view) => command(view)) }
}

/** Builder choisi selon la sélection : vide (toutes les plages) ou non. */
function bySelection(empty: EditBuilder, selected: EditBuilder): EditBuilder {
  return (state) =>
    state.selection.ranges.every((range) => range.empty) ? empty(state) : selected(state)
}

/** Action qui appelle un callback de l'application (désactivée si l'application ne le fournit pas). */
function hostAction(
  action: Omit<EditorAction, 'run' | 'when'>,
  callback: (host: ActionHost) => (() => void) | undefined,
  options: { edits?: boolean } = {},
): EditorAction {
  return {
    ...action,
    when: (context) =>
      callback(context.host) !== undefined && !(options.edits === true && isReadOnly(context)),
    run: ({ host }) => {
      const run = callback(host)
      if (run === undefined) return false
      run()
      return true
    },
  }
}

/** Texte sélectionné (plage principale), sur une ligne et rogné. */
function selectedText(view: EditorView | null): string {
  if (view === null) return ''
  const { from, to } = view.state.selection.main
  const text = view.state.sliceDoc(from, to)
  return text.includes('\n') ? '' : text.trim()
}

// --- File ---------------------------------------------------------------------------------------

const fileActions: EditorAction[] = [
  hostAction(
    {
      id: 'file.new-file',
      label: 'Nouveau fichier',
      menu: 'file',
      group: 'create',
      icon: 'file-plus',
    },
    (host) => host.newFile,
    { edits: true },
  ),
  hostAction(
    {
      id: 'file.new-folder',
      label: 'Nouveau dossier',
      menu: 'file',
      group: 'create',
      icon: 'folder-plus',
    },
    (host) => host.newFolder,
    { edits: true },
  ),
  hostAction(
    {
      id: 'file.upload',
      label: 'Téléverser des fichiers',
      menu: 'file',
      group: 'create',
      icon: 'upload',
    },
    (host) => host.upload,
    { edits: true },
  ),
  hostAction(
    {
      id: 'file.download-zip',
      label: 'Télécharger le projet (zip)',
      menu: 'file',
      group: 'export',
      icon: 'download',
    },
    (host) => host.downloadZip,
  ),
]

// --- Format -------------------------------------------------------------------------------------

/** Commande de texte `\cmd{…}` qui enrobe ou désenrobe la sélection. */
function textCommand(
  id: string,
  label: string,
  command: string,
  icon: string,
  shortcut?: string,
): EditorAction {
  return editAction(
    {
      id: `format.${id}`,
      label,
      menu: 'format',
      group: 'style',
      icon,
      ...(shortcut === undefined ? {} : { shortcut }),
    },
    toggleWrap(`\\${command}{`, '}'),
  )
}

/** Tailles de police de LaTeX, de la plus petite à la plus grande. */
export const FONT_SIZES = [
  { command: 'tiny', label: 'Minuscule' },
  { command: 'scriptsize', label: 'Très petite' },
  { command: 'footnotesize', label: 'Note de bas de page' },
  { command: 'small', label: 'Petite' },
  { command: 'normalsize', label: 'Normale' },
  { command: 'large', label: 'Grande' },
  { command: 'Large', label: 'Plus grande' },
  { command: 'LARGE', label: 'Très grande' },
  { command: 'huge', label: 'Énorme' },
  { command: 'Huge', label: 'Gigantesque' },
] as const

const formatActions: EditorAction[] = [
  textCommand('bold', 'Gras', 'textbf', 'bold', 'Mod-b'),
  textCommand('italic', 'Italique', 'textit', 'italic', 'Mod-i'),
  textCommand('underline', 'Souligné', 'underline', 'underline'),
  textCommand('emph', 'Emphase', 'emph', 'highlighter'),
  textCommand('code', 'Code (machine à écrire)', 'texttt', 'code'),
  textCommand('small-caps', 'Petites capitales', 'textsc', 'case-upper'),
  ...FONT_SIZES.map(({ command, label }) =>
    editAction(
      {
        id: `format.size.${command}`,
        label: `Taille : ${label} (\\${command})`,
        menu: 'format',
        group: 'size',
        icon: 'a-large-small',
      },
      toggleWrap(`{\\${command} `, '}'),
    ),
  ),
  {
    id: 'format.comment',
    label: 'Commenter ou décommenter',
    menu: 'format',
    group: 'comment',
    icon: 'message-square-off',
    shortcut: 'Mod-/',
    when: canEdit,
    run: onView((view) => toggleComment(view)),
  },
]

// --- Structures ---------------------------------------------------------------------------------

/** Commandes de sectionnement proposées dans le menu, du plus haut niveau au plus bas. */
const SECTIONS = [
  { command: 'part', label: 'Partie' },
  { command: 'chapter', label: 'Chapitre' },
  { command: 'section', label: 'Section' },
  { command: 'subsection', label: 'Sous-section' },
  { command: 'subsubsection', label: 'Sous-sous-section' },
  { command: 'paragraph', label: 'Paragraphe' },
] as const

/** Environnement simple : `\begin{name}` … `\end{name}`, contenu indenté. */
function environment(name: string, body: readonly string[], extra: Partial<BlockTemplate> = {}) {
  return insertBlock({
    before: [`\\begin{${name}}`],
    after: [`\\end{${name}}`],
    body,
    ...extra,
  })
}

const listActions: EditorAction[] = [
  editAction(
    {
      id: 'structures.itemize',
      label: 'Liste à puces',
      menu: 'structures',
      group: 'lists',
      icon: 'list',
    },
    environment('itemize', [`\t\\item ${CURSOR}`], { linePrefix: '\\item ' }),
  ),
  editAction(
    {
      id: 'structures.enumerate',
      label: 'Liste numérotée',
      menu: 'structures',
      group: 'lists',
      icon: 'list-ordered',
    },
    environment('enumerate', [`\t\\item ${CURSOR}`], { linePrefix: '\\item ' }),
  ),
  editAction(
    {
      id: 'structures.description',
      label: 'Liste de descriptions',
      menu: 'structures',
      group: 'lists',
      icon: 'list-tree',
    },
    environment('description', [`\t\\item[${CURSOR}] `], { linePrefix: '\\item[] ' }),
  ),
]

const floatActions: EditorAction[] = [
  editAction(
    {
      id: 'structures.figure',
      label: 'Figure',
      menu: 'structures',
      group: 'floats',
      icon: 'image',
    },
    insertBlock({
      before: ['\\begin{figure}[htbp]', '\t\\centering'],
      body: [`\t${CURSOR}`],
      after: ['\t\\caption{}', '\t\\label{fig:}', '\\end{figure}'],
    }),
  ),
]

const referenceActions: EditorAction[] = [
  editAction(
    {
      id: 'structures.footnote',
      label: 'Note de bas de page',
      menu: 'structures',
      group: 'references',
      icon: 'superscript',
    },
    toggleWrap('\\footnote{', '}'),
  ),
  editAction(
    {
      id: 'structures.label',
      label: 'Étiquette (\\label)',
      menu: 'structures',
      group: 'references',
      icon: 'tag',
    },
    toggleWrap('\\label{', '}'),
  ),
  editAction(
    {
      id: 'structures.ref',
      label: 'Renvoi (\\ref)',
      menu: 'structures',
      group: 'references',
      icon: 'link',
    },
    toggleWrap('\\ref{', '}'),
  ),
  editAction(
    {
      id: 'structures.cite',
      label: 'Citation (\\cite)',
      menu: 'structures',
      group: 'references',
      icon: 'quote',
    },
    toggleWrap('\\cite{', '}'),
  ),
]

const structureActions: EditorAction[] = [
  ...SECTIONS.map(({ command, label }) =>
    editAction(
      {
        id: `structures.${command}`,
        label,
        menu: 'structures',
        group: 'sectioning',
        icon: 'heading',
      },
      // Sans sélection : titre sur sa propre ligne ; avec : le texte sélectionné devient le titre.
      bySelection(
        replaceWithBlock(() => ({ before: [`\\${command}{${CURSOR}}`], after: [] })),
        toggleWrap(`\\${command}{`, '}'),
      ),
    ),
  ),
  ...listActions,
  ...floatActions,
  ...referenceActions,
  editAction(
    {
      id: 'structures.environment',
      label: 'Environnement personnalisé',
      menu: 'structures',
      group: 'environment',
      icon: 'braces',
    },
    // Deux curseurs : le nom se tape une fois dans \begin et \end.
    insertBlock({ before: [`\\begin{${CURSOR}}`], after: [`\\end{${CURSOR}}`], body: [''] }),
  ),
]

// --- Math ---------------------------------------------------------------------------------------

const AMSMATH: readonly RequiredPackage[] = [{ name: 'amsmath' }]

const mathActions: EditorAction[] = [
  editAction(
    {
      id: 'math.inline',
      label: 'Formule en ligne \\( \\)',
      menu: 'math',
      group: 'modes',
      icon: 'sigma',
    },
    toggleWrap('\\(', '\\)'),
  ),
  editAction(
    {
      id: 'math.display',
      label: 'Formule centrée \\[ \\]',
      menu: 'math',
      group: 'modes',
      icon: 'square-sigma',
    },
    insertBlock({ before: ['\\['], after: ['\\]'], body: [`\t${CURSOR}`] }),
  ),
  editAction(
    {
      id: 'math.equation',
      label: 'Équation numérotée',
      menu: 'math',
      group: 'modes',
      icon: 'hash',
    },
    insertBlock({
      before: ['\\begin{equation}'],
      after: ['\\end{equation}'],
      body: [`\t${CURSOR}`],
    }),
  ),
  editAction(
    {
      id: 'math.align',
      label: 'Équations alignées (align)',
      menu: 'math',
      group: 'modes',
      icon: 'align-left',
    },
    insertBlock({
      before: ['\\begin{align}'],
      after: ['\\end{align}'],
      body: [`\t${CURSOR} &= \\\\`, '\t &= '],
    }),
    AMSMATH,
  ),
  editAction(
    { id: 'math.fraction', label: 'Fraction', menu: 'math', group: 'snippets', icon: 'divide' },
    inlineSnippet('\\frac{', `}{${CURSOR}}`),
  ),
  editAction(
    { id: 'math.sqrt', label: 'Racine carrée', menu: 'math', group: 'snippets', icon: 'radical' },
    toggleWrap('\\sqrt{', '}'),
  ),
  editAction(
    { id: 'math.root', label: 'Racine n-ième', menu: 'math', group: 'snippets', icon: 'radical' },
    inlineSnippet(`\\sqrt[${CURSOR}]{`, '}'),
  ),
  editAction(
    {
      id: 'math.superscript',
      label: 'Exposant',
      menu: 'math',
      group: 'snippets',
      icon: 'superscript',
    },
    toggleWrap('^{', '}'),
  ),
  editAction(
    { id: 'math.subscript', label: 'Indice', menu: 'math', group: 'snippets', icon: 'subscript' },
    toggleWrap('_{', '}'),
  ),
]

// --- Graphics -----------------------------------------------------------------------------------

const GRAPHICX: readonly RequiredPackage[] = [{ name: 'graphicx' }]

const graphicsActions: EditorAction[] = [
  editAction(
    {
      id: 'graphics.figure',
      label: 'Image dans une figure',
      menu: 'graphics',
      group: 'insert',
      icon: 'image',
    },
    // Le texte sélectionné sert de chemin d'image.
    replaceWithBlock((selection) => ({
      before: ['\\begin{figure}[htbp]', '\t\\centering'],
      body: [`\t\\includegraphics[width=0.8\\linewidth]{${selection === '' ? CURSOR : selection}}`],
      after: [`\t\\caption{${selection === '' ? '' : CURSOR}}`, '\t\\label{fig:}', '\\end{figure}'],
    })),
    GRAPHICX,
  ),
  editAction(
    {
      id: 'graphics.includegraphics',
      label: 'Image seule (\\includegraphics)',
      menu: 'graphics',
      group: 'insert',
      icon: 'image-plus',
    },
    toggleWrap('\\includegraphics[width=\\linewidth]{', '}'),
    GRAPHICX,
  ),
  hostAction(
    {
      id: 'graphics.upload',
      label: 'Téléverser une image',
      menu: 'graphics',
      group: 'files',
      icon: 'upload',
    },
    (host) => host.upload,
    { edits: true },
  ),
]

// --- Packages -----------------------------------------------------------------------------------

/**
 * Charge `name` (avec `options`) dans le préambule : nouvelle ligne `\usepackage`, options ajoutées
 * à une commande existante, ou rien si le package est déjà là. Avec `name` vide, insère
 * `\usepackage{}` et place le curseur entre les accolades. Une seule étape d'annulation.
 */
export function addPackage(
  view: EditorView,
  name: string,
  options: readonly string[] = [],
): ReturnType<typeof planPackage>['status'] {
  const plan = planPackage(view.state.doc, name, options)
  if (view.state.readOnly) return plan.status
  if (plan.status === 'insert' || plan.status === 'update') {
    const command: StateCommand = editCommand(() => ({
      changes: plan.change,
      ...(plan.status === 'insert' && name === ''
        ? { selection: EditorSelection.cursor(plan.change.from + plan.nameOffset) }
        : {}),
    }))
    command(view)
  }
  return plan.status
}

const packageActions: EditorAction[] = [
  {
    id: 'packages.usepackage',
    label: 'Ajouter \\usepackage{} au préambule',
    menu: 'packages',
    group: 'preamble',
    icon: 'package-plus',
    when: canEdit,
    run: ({ view, host }) => {
      if (view === null) return false
      const status = addPackage(view, '')
      if (status === 'no-preamble') {
        host.notify?.(
          'Ce fichier n’a pas de préambule : ajoutez le package dans le fichier principal.',
          'warning',
        )
        return false
      }
      view.focus()
      return true
    },
  },
]

// --- Search et Replace --------------------------------------------------------------------------

/** Ouvre le panneau de recherche et place le focus dans le champ de remplacement. */
function openReplacePanel(view: EditorView): boolean {
  openSearchPanel(view)
  const field = view.dom.querySelector<HTMLInputElement>('.cm-search input[name=replace]')
  if (field === null) return false
  field.focus()
  field.select()
  return true
}

const searchActions: EditorAction[] = [
  {
    id: 'search.find',
    label: 'Rechercher dans le fichier',
    menu: 'search',
    group: 'file',
    icon: 'search',
    shortcut: 'Mod-f',
    when: hasEditor,
    run: ({ view }) => (view === null ? false : openSearchPanel(view)),
  },
  {
    id: 'search.next',
    label: 'Occurrence suivante',
    menu: 'search',
    group: 'file',
    icon: 'arrow-down',
    when: hasEditor,
    run: onView(findNext),
  },
  {
    id: 'search.previous',
    label: 'Occurrence précédente',
    menu: 'search',
    group: 'file',
    icon: 'arrow-up',
    when: hasEditor,
    run: onView(findPrevious),
  },
  {
    id: 'search.go-to-line',
    label: 'Aller à la ligne…',
    menu: 'search',
    group: 'navigation',
    icon: 'arrow-right-to-line',
    shortcut: 'Mod-Alt-g',
    when: hasEditor,
    run: ({ view }) => (view === null ? false : gotoLine(view)),
  },
  {
    id: 'search.project',
    label: 'Rechercher dans tout le projet',
    menu: 'search',
    group: 'project',
    icon: 'folder-search',
    shortcut: 'Mod-Shift-f',
    when: (context) => context.host.searchProject !== undefined,
    run: ({ view, host }) => {
      if (host.searchProject === undefined) return false
      host.searchProject(selectedText(view))
      return true
    },
  },
]

const replaceActions: EditorAction[] = [
  {
    id: 'replace.open',
    label: 'Rechercher et remplacer',
    menu: 'replace',
    group: 'file',
    icon: 'replace',
    // Mod-h est réservé par macOS (masquer l'application) : Mod-Alt-f à la place.
    shortcut: 'Mod-Alt-f',
    when: canEdit,
    run: ({ view }) => (view === null ? false : openReplacePanel(view)),
  },
  {
    id: 'replace.next',
    label: 'Remplacer l’occurrence suivante',
    menu: 'replace',
    group: 'file',
    icon: 'replace',
    when: canEdit,
    run: onView(replaceNext),
  },
  {
    id: 'replace.all',
    label: 'Tout remplacer',
    menu: 'replace',
    group: 'file',
    icon: 'replace-all',
    when: canEdit,
    run: onView(replaceAll),
  },
]

/** Actions de base (étape 1 et outils d'écriture), dans l'ordre des menus. */
export const defaultActions: readonly EditorAction[] = [
  ...fileActions,
  ...formatActions,
  ...structureActions,
  // Outils d'écriture (formules, symboles, tableaux) : en tête du menu Maths, avec les flottants.
  ...writingActions,
  ...mathActions,
  ...graphicsActions,
  ...packageActions,
  ...searchActions,
  ...replaceActions,
]

/** Registre contenant les actions de base ; les outils des tâches suivantes s'y ajoutent. */
export function createDefaultRegistry(): ActionRegistry {
  return createActionRegistry(defaultActions)
}
