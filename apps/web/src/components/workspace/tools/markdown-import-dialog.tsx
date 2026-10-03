'use client'

import type { EditorView } from '@codemirror/view'
import type {
  ConvertTopLevelDivision,
  MarkdownImportBody,
  MarkdownImportOutput,
  MarkdownImportPreamble,
  MarkdownImportResponse,
} from '@kaxolax/contracts'
import { isMarkdownImportPayload, type MarkdownImportPayload } from '@kaxolax/editor'
import {
  Alert,
  Button,
  Checkbox,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
  NativeSelect,
  Spinner,
  Tabs,
  TabsList,
  TabsTrigger,
  ToggleGroup,
  ToggleGroupItem,
} from '@kaxolax/ui'
import { FileUpIcon, SparklesIcon } from 'lucide-react'
import { type ReactNode, useEffect, useId, useMemo, useRef, useState } from 'react'
import { api, type TreeDocument } from '@/lib/api'
import {
  composeInsertions,
  defaultTargetPath,
  includePath,
  insertionRange,
  isMarkdownPath,
  markdownImportErrorMessage,
  planInclude,
  pastedTextToReplace,
  planPreambleMerge,
  preambleMergeMessage,
  type TextInsertion,
} from '@/lib/markdown-import'
import type { ActionDialogProps } from '../action-dialogs'
import { useWorkspaceTools, type WorkspaceTools } from '../workspace-tools'
import { focusEditorOnClose } from '../writing/writing-common'

type Source = 'paste' | 'project'

/** Taille maximale d'un fichier `.md` choisi sur l'ordinateur (celle de l'API). */
const MAX_LOCAL_FILE_BYTES = 2 * 1024 * 1024

const DIVISIONS: readonly { value: ConvertTopLevelDivision; label: string }[] = [
  { value: 'section', label: '\\section' },
  { value: 'chapter', label: '\\chapter' },
  { value: 'part', label: '\\part' },
  { value: 'default', label: 'Selon la classe' },
]

interface Preview {
  /** Demande dont l'aperçu est le résultat : un autre réglage le rend périmé. */
  key: string
  result: MarkdownImportResponse
}

/**
 * « Importer du Markdown » (menu Fichier, menu d'un `.md` de l'arborescence, collage
 * intelligent, upload d'un `.md`) : Markdown collé, fichier de l'ordinateur ou du projet, converti
 * par pandoc dans le sandbox. Aperçu du LaTeX, puis insertion dans le document courant ou nouveau
 * fichier ; le préambule du document principal est complété dans l'éditeur (sans doublon).
 */
export default function MarkdownImportDialog({ payload, context, onClose }: ActionDialogProps) {
  if (!isMarkdownImportPayload(payload)) return null
  return <MarkdownImport payload={payload} context={context} onClose={onClose} />
}

function MarkdownImport({
  payload,
  context,
  onClose,
}: Omit<ActionDialogProps, 'payload'> & { payload: MarkdownImportPayload }) {
  const tools = useWorkspaceTools()
  const ids = useId()
  const fileInput = useRef<HTMLInputElement>(null)
  const markdownDocuments = useMemo(
    () => tools.documents.filter((document) => isMarkdownPath(document.path)),
    [tools.documents],
  )
  const active = tools.activeDocument
  const view = context().view
  const canInsert =
    tools.canEdit &&
    view !== null &&
    !view.state.readOnly &&
    active !== null &&
    /\.(?:tex|ltx)$/i.test(active.path)

  // Document du texte à remplacer : celui du collage, sinon celui ouvert à l'ouverture.
  const [replaceOrigin] = useState(() => payload.replace?.documentId ?? active?.id ?? null)
  const [source, setSource] = useState<Source>(
    payload.documentId !== undefined ? 'project' : 'paste',
  )
  const [markdown, setMarkdown] = useState(payload.markdown ?? '')
  const [documentId, setDocumentId] = useState(payload.documentId ?? markdownDocuments[0]?.id ?? '')
  const [output, setOutput] = useState<MarkdownImportOutput>(
    canInsert && payload.documentId === undefined ? 'insert' : 'file',
  )
  const [preamble, setPreamble] = useState<MarkdownImportPreamble>('main')
  const selectedDocument =
    markdownDocuments.find((document) => document.id === documentId) ??
    (documentId === '' ? (markdownDocuments[0] ?? null) : null)
  // Nom du fichier choisi sur l'ordinateur (nom proposé pour le `.tex`).
  const [localName, setLocalName] = useState<string | null>(null)
  const replace = pastedTextToReplace(payload.replace, {
    source,
    localFile: localName !== null,
    markdown,
    activeDocumentId: active?.id ?? null,
    originDocumentId: replaceOrigin,
  })
  // Fichier à créer saisi par l'utilisateur ; null : déduit de la source (l'arborescence peut
  // arriver après l'ouverture, juste après un upload).
  const [typedTarget, setTypedTarget] = useState<string | null>(null)
  const targetPath =
    typedTarget ??
    defaultTargetPath(source === 'project' ? (selectedDocument?.path ?? null) : localName)
  const [include, setInclude] = useState(true)
  const [division, setDivision] = useState<ConvertTopLevelDivision>('section')
  const [numbered, setNumbered] = useState(true)
  const [rawLatex, setRawLatex] = useState(false)
  const [cleanup, setCleanup] = useState(false)
  const [aiEnabled, setAiEnabled] = useState<boolean | null>(null)
  const [preview, setPreview] = useState<Preview | null>(null)
  const [useCleaned, setUseCleaned] = useState(true)
  const [busy, setBusy] = useState<'preview' | 'apply' | null>(null)
  const [error, setError] = useState<string | null>(null)

  const effectiveOutput: MarkdownImportOutput = canInsert ? output : 'file'
  const effectivePreamble: MarkdownImportPreamble = effectiveOutput === 'insert' ? 'main' : preamble
  const hasSource = source === 'paste' ? markdown.trim() !== '' : selectedDocument !== null
  const targetValid = /^[^/].*\.tex$/i.test(targetPath.trim()) && !targetPath.includes('..')

  // IA utilisable pour ce projet (configurée et activée) : sinon le nettoyage est grisé.
  const { projectId } = tools
  useEffect(() => {
    const status = { live: true }
    api.projectAi(projectId).then(
      (settings) => {
        if (status.live) setAiEnabled(settings.enabled)
      },
      () => {
        if (status.live) setAiEnabled(false)
      },
    )
    return () => {
      status.live = false
    }
  }, [projectId])

  const body: MarkdownImportBody = {
    ...(source === 'paste' ? { markdown } : { documentId: selectedDocument?.id ?? documentId }),
    output: effectiveOutput,
    preamble: effectivePreamble,
    ...(effectiveOutput === 'file'
      ? { targetPath: targetPath.trim() }
      : active !== null && /\.tex$/i.test(active.path)
        ? { targetPath: active.path }
        : {}),
    topLevelDivision:
      effectivePreamble === 'embedded' && division === 'section' ? 'default' : division,
    // Fragment (préambule du document principal) : numérotation du document hôte, rien à envoyer.
    ...(effectivePreamble === 'embedded' ? { numberSections: numbered } : {}),
    rawLatex,
  }
  const key = JSON.stringify(body)
  const current = preview?.key === `${key}:${String(cleanup)}` ? preview.result : null
  const cleaned = current?.cleanup?.applied === true && current.pandocLatex !== null
  const shownLatex =
    current === null ? '' : cleaned && !useCleaned ? (current.pandocLatex ?? '') : current.latex
  // Un nettoyage par l'IA se valide dans l'aperçu avant d'être écrit.
  const needsPreview = cleanup && current === null
  const ready = hasSource && (effectiveOutput === 'insert' || targetValid) && busy === null

  const runPreview = async () => {
    setBusy('preview')
    setError(null)
    try {
      const result = await api.convertMarkdown(projectId, { ...body, cleanup, dryRun: true })
      setPreview({ key: `${key}:${String(cleanup)}`, result })
      setUseCleaned(true)
    } catch (caught) {
      setError(markdownImportErrorMessage(caught))
    } finally {
      setBusy(null)
    }
  }

  const apply = async () => {
    setBusy('apply')
    setError(null)
    try {
      // Texte validé dans l'aperçu (nettoyé par l'IA) : écrit tel quel, sans nouvel appel à l'IA,
      // et refusé par l'API (E_SOURCE_CHANGED) si le Markdown a changé depuis l'aperçu.
      const validated =
        cleaned && useCleaned ? { latex: current.latex, sourceSha256: current.sourceSha256 } : {}
      const result = await api.convertMarkdown(projectId, { ...body, ...validated })
      const messages: string[] = []
      if (result.output === 'insert') {
        const target = context().view
        if (target === null || target.state.readOnly) {
          throw new Error('Le document courant n’est plus modifiable : rien n’a été inséré.')
        }
        const replaced = insertFragment(target, result.latex, replace)
        messages.push(
          replace !== undefined && !replaced
            ? 'Texte collé introuvable (modifié entre-temps) : Markdown converti et inséré au curseur.'
            : 'Markdown converti et inséré.',
        )
      } else {
        await tools.refreshTree()
        messages.push(`${result.targetPath} créé.`)
      }
      messages.push(...(await completeMain(tools, result, include)))
      if (result.output === 'file' && result.document !== null) {
        tools.openDocument(result.document.id)
      }
      context().host.notify?.(messages.join(' '), 'info')
      onClose()
    } catch (caught) {
      // Aperçu périmé (Markdown modifié entre-temps) : il faut le relancer.
      if (caught instanceof Error && 'code' in caught && caught.code === 'E_SOURCE_CHANGED') {
        setPreview(null)
      }
      setError(markdownImportErrorMessage(caught))
      setBusy(null)
    }
  }

  const loadLocalFile = async (file: File) => {
    if (file.size > MAX_LOCAL_FILE_BYTES) {
      setError('Ce fichier dépasse 2 Mo.')
      return
    }
    setMarkdown(await file.text())
    setLocalName(file.name)
    setSource('paste')
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    >
      <DialogContent
        className="max-h-[92dvh] overflow-y-auto sm:max-w-3xl"
        onCloseAutoFocus={(event) => {
          focusEditorOnClose(event, context)
        }}
        data-testid="markdown-import"
      >
        <DialogHeader>
          <DialogTitle>Importer du Markdown</DialogTitle>
          <DialogDescription>
            Converti en LaTeX par pandoc, dans le compilateur isolé. Titres, listes, tableaux,
            formules, notes, liens, images et citations sont repris.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-3">
          <Tabs
            value={source}
            onValueChange={(value) => {
              if (value === 'paste' || value === 'project') setSource(value)
            }}
          >
            <TabsList>
              <TabsTrigger value="paste">Coller du Markdown</TabsTrigger>
              <TabsTrigger value="project" disabled={markdownDocuments.length === 0}>
                Fichier du projet ({markdownDocuments.length})
              </TabsTrigger>
            </TabsList>
          </Tabs>

          {source === 'paste' ? (
            <div className="grid gap-1.5">
              <div className="flex items-center justify-between gap-2">
                <Label htmlFor={`${ids}-markdown`}>Markdown</Label>
                <Button
                  size="xs"
                  variant="outline"
                  onClick={() => {
                    fileInput.current?.click()
                  }}
                >
                  <FileUpIcon aria-hidden />
                  Choisir un fichier .md…
                </Button>
                <input
                  ref={fileInput}
                  type="file"
                  accept=".md,.markdown,text/markdown"
                  className="hidden"
                  data-testid="markdown-file-input"
                  onChange={(event) => {
                    const file = event.target.files?.[0]
                    event.target.value = ''
                    if (file) void loadLocalFile(file)
                  }}
                />
              </div>
              <textarea
                id={`${ids}-markdown`}
                value={markdown}
                onChange={(event) => {
                  setMarkdown(event.target.value)
                }}
                spellCheck={false}
                rows={8}
                placeholder={
                  '# Titre\n\nDu texte avec **gras**, une [référence](https://…) et $x^2$.'
                }
                className="min-h-32 w-full resize-y rounded-md border border-input bg-transparent px-3 py-2 font-mono text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 dark:bg-input/30"
              />
            </div>
          ) : (
            <div className="grid gap-1.5">
              <Label htmlFor={`${ids}-document`}>Fichier Markdown</Label>
              <NativeSelect
                id={`${ids}-document`}
                value={selectedDocument?.id ?? documentId}
                onChange={(event) => {
                  setDocumentId(event.target.value)
                  setTypedTarget(null)
                }}
              >
                {markdownDocuments.map((document: TreeDocument) => (
                  <option key={document.id} value={document.id}>
                    {document.path}
                  </option>
                ))}
              </NativeSelect>
            </div>
          )}

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="grid content-start gap-1.5">
              <span className="text-sm font-medium" id={`${ids}-output`}>
                Destination
              </span>
              <ToggleGroup
                type="single"
                variant="outline"
                size="sm"
                value={effectiveOutput}
                aria-labelledby={`${ids}-output`}
                onValueChange={(value) => {
                  if (value === 'insert' || value === 'file') setOutput(value)
                }}
              >
                <ToggleGroupItem value="insert" disabled={!canInsert} className="px-3">
                  Document courant
                </ToggleGroupItem>
                <ToggleGroupItem value="file" className="px-3">
                  Nouveau fichier
                </ToggleGroupItem>
              </ToggleGroup>
              {effectiveOutput === 'insert' && active !== null ? (
                <p className="text-xs text-muted-foreground">
                  Inséré dans {active.path}
                  {replace ? ', à la place du texte collé' : ', au curseur'}.
                </p>
              ) : null}
              {effectiveOutput === 'file' ? (
                <div className="grid gap-1.5">
                  <Label htmlFor={`${ids}-target`}>Fichier à créer</Label>
                  <Input
                    id={`${ids}-target`}
                    value={targetPath}
                    onChange={(event) => {
                      setTypedTarget(event.target.value)
                    }}
                    aria-invalid={!targetValid}
                    className="h-8 font-mono"
                  />
                </div>
              ) : null}
            </div>

            <div className="grid content-start gap-1.5">
              <span className="text-sm font-medium" id={`${ids}-preamble`}>
                Préambule
              </span>
              <ToggleGroup
                type="single"
                variant="outline"
                size="sm"
                value={effectivePreamble}
                aria-labelledby={`${ids}-preamble`}
                onValueChange={(value) => {
                  if (value === 'main' || value === 'embedded') setPreamble(value)
                }}
              >
                <ToggleGroupItem value="main" className="px-3">
                  Document principal
                </ToggleGroupItem>
                <ToggleGroupItem
                  value="embedded"
                  disabled={effectiveOutput === 'insert'}
                  className="px-3"
                >
                  Document autonome
                </ToggleGroupItem>
              </ToggleGroup>
              <p className="text-xs text-muted-foreground">
                {effectivePreamble === 'main'
                  ? tools.mainDocument
                    ? `Les packages nécessaires sont ajoutés à ${tools.mainDocument.path}, sans doublon.`
                    : 'Choisissez un document principal pour y ajouter les packages nécessaires.'
                  : 'Le fichier créé est un document LaTeX complet, avec son propre préambule.'}
              </p>
              {effectiveOutput === 'file' &&
              effectivePreamble === 'main' &&
              tools.mainDocument !== null ? (
                <div className="flex items-center gap-2">
                  <Checkbox
                    id={`${ids}-include`}
                    checked={include}
                    onCheckedChange={(checked) => {
                      setInclude(checked === true)
                    }}
                  />
                  <Label htmlFor={`${ids}-include`} className="text-xs font-normal">
                    Inclure le fichier dans {tools.mainDocument.path} (\input)
                  </Label>
                </div>
              ) : null}
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <div className="flex items-center gap-2">
              <Label htmlFor={`${ids}-division`} className="text-xs font-normal">
                Titres #
              </Label>
              <NativeSelect
                id={`${ids}-division`}
                value={division}
                onChange={(event) => {
                  const value = DIVISIONS.find((item) => item.value === event.target.value)
                  if (value) setDivision(value.value)
                }}
                className="h-8 font-mono text-xs"
              >
                {DIVISIONS.map((item) => (
                  <option key={item.value} value={item.value}>
                    {item.label}
                  </option>
                ))}
              </NativeSelect>
            </div>
            {effectivePreamble === 'embedded' ? (
              <Option
                id={`${ids}-numbered`}
                checked={numbered}
                onChange={setNumbered}
                label="Titres numérotés"
              />
            ) : (
              <span className="text-xs text-muted-foreground" data-testid="markdown-numbering">
                Numérotation du document principal
              </span>
            )}
            <Option
              id={`${ids}-raw`}
              checked={rawLatex}
              onChange={setRawLatex}
              label="Garder le LaTeX brut du Markdown"
            />
            <Option
              id={`${ids}-cleanup`}
              checked={cleanup && aiEnabled === true}
              disabled={aiEnabled !== true}
              onChange={setCleanup}
              label={
                <span className="inline-flex items-center gap-1">
                  <SparklesIcon className="size-3.5" aria-hidden />
                  Nettoyer avec l’IA (crédits IA)
                  {aiEnabled === false ? ' — désactivée pour ce projet' : ''}
                </span>
              }
            />
          </div>

          {error ? (
            <Alert variant="destructive" role="alert" className="py-2 text-sm">
              {error}
            </Alert>
          ) : null}

          {current !== null ? (
            <PreviewPane
              result={current}
              latex={shownLatex}
              cleaned={cleaned}
              useCleaned={useCleaned}
              onUseCleaned={setUseCleaned}
              mainPath={tools.mainDocument?.path ?? null}
            />
          ) : null}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Annuler
          </Button>
          <Button variant="outline" disabled={!ready} onClick={() => void runPreview()}>
            {busy === 'preview' ? <Spinner /> : null}
            Aperçu
          </Button>
          <Button disabled={!ready || needsPreview} onClick={() => void apply()}>
            {busy === 'apply' ? <Spinner /> : null}
            {effectiveOutput === 'insert' ? 'Insérer' : 'Créer le fichier'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function Option({
  id,
  checked,
  disabled = false,
  onChange,
  label,
}: {
  id: string
  checked: boolean
  disabled?: boolean
  onChange: (value: boolean) => void
  label: ReactNode
}) {
  return (
    <div className="flex items-center gap-2">
      <Checkbox
        id={id}
        checked={checked}
        disabled={disabled}
        onCheckedChange={(value) => {
          onChange(value === true)
        }}
      />
      <Label htmlFor={id} className="text-xs font-normal">
        {label}
      </Label>
    </div>
  )
}

/** Aperçu : LaTeX produit, version nettoyée ou non, préambule à compléter, avertissements. */
export function PreviewPane({
  result,
  latex,
  cleaned,
  useCleaned,
  onUseCleaned,
  mainPath,
}: {
  result: MarkdownImportResponse
  latex: string
  cleaned: boolean
  useCleaned: boolean
  onUseCleaned: (value: boolean) => void
  mainPath: string | null
}) {
  const { preamble } = result
  const missing = [
    ...preamble.missingPackages.map((entry) => entry.name),
    ...preamble.missingDefinitions.map((entry) => `\\${entry.name}`),
  ]
  return (
    <section className="grid gap-2" aria-label="Aperçu du LaTeX">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-medium">Aperçu du LaTeX</h3>
        {cleaned ? (
          <ToggleGroup
            type="single"
            variant="outline"
            size="sm"
            value={useCleaned ? 'cleaned' : 'pandoc'}
            aria-label="Version"
            onValueChange={(value) => {
              if (value === 'cleaned' || value === 'pandoc') onUseCleaned(value === 'cleaned')
            }}
          >
            <ToggleGroupItem value="cleaned" className="px-3">
              Nettoyée par l’IA
            </ToggleGroupItem>
            <ToggleGroupItem value="pandoc" className="px-3">
              Sortie de pandoc
            </ToggleGroupItem>
          </ToggleGroup>
        ) : null}
      </div>
      <pre
        className="max-h-72 overflow-auto rounded-md border bg-muted/40 p-3 font-mono text-xs whitespace-pre-wrap"
        data-testid="markdown-preview"
      >
        {latex}
      </pre>
      <ul className="grid gap-1 text-xs text-muted-foreground">
        {preamble.mode === 'main' ? (
          <li>
            {missing.length === 0
              ? `Préambule${mainPath ? ` de ${mainPath}` : ''} : rien à ajouter.`
              : `À ajouter au préambule${mainPath ? ` de ${mainPath}` : ''} : ${missing.join(', ')}.`}
          </li>
        ) : null}
        {result.media.length > 0 ? (
          <li>Images extraites : {result.media.map((media) => media.path).join(', ')}.</li>
        ) : null}
        {result.cleanup !== null ? (
          <li>Nettoyage par l’IA : {result.cleanup.credits.toFixed(2)} crédit(s) utilisé(s).</li>
        ) : null}
        {result.warnings.map((warning) => (
          <li key={warning} className="text-amber-700 dark:text-amber-400">
            {warning}
          </li>
        ))}
      </ul>
    </section>
  )
}

/**
 * Insère le fragment converti à la place du texte collé (retrouvé même déplacé) ou de la
 * sélection ; renvoie vrai si le texte collé a été remplacé.
 */
function insertFragment(
  view: EditorView,
  latex: string,
  replace: MarkdownImportPayload['replace'],
): boolean {
  const { state } = view
  const range = insertionRange(state.doc.toString(), state.selection.main, replace)
  view.dispatch({
    changes: { from: range.from, to: range.to, insert: latex },
    selection: { anchor: range.from + latex.length },
    scrollIntoView: true,
    userEvent: 'input.markdown',
  })
  view.focus()
  return range.replaced
}

/**
 * Complète le document principal dans l'éditeur partagé : packages et définitions qui lui
 * manquent (recalculés sur son texte courant), puis `\input` du fichier créé si demandé. Renvoie
 * les messages à afficher.
 */
async function completeMain(
  tools: WorkspaceTools,
  result: MarkdownImportResponse,
  include: boolean,
): Promise<string[]> {
  const { preamble } = result
  if (preamble.mode !== 'main') return []
  const main = tools.mainDocument
  if (main === null) {
    return preamble.packages.length > 0
      ? [
          `Pas de document principal : chargez ${preamble.packages.map((entry) => entry.name).join(', ')}.`,
        ]
      : []
  }
  const wantsInclude = include && result.output === 'file' && result.document !== null
  const hasWork =
    preamble.missingPackages.length > 0 || preamble.missingDefinitions.length > 0 || wantsInclude
  if (!hasWork) return []
  const messages: string[] = []
  const edit = (view: EditorView) => {
    if (view.state.readOnly) return false
    const text = view.state.doc.toString()
    const merge = planPreambleMerge(text, preamble.packages, preamble.definitions)
    messages.push(preambleMergeMessage(merge, main.path))
    let merged = text
    const changes: TextInsertion[] = [...merge.changes]
    for (const change of merge.changes) {
      merged = merged.slice(0, change.from) + change.insert + merged.slice(change.from)
    }
    if (wantsInclude) {
      const included = planInclude(merged, includePath(main.path, result.targetPath))
      if (included !== null) {
        changes.push(included)
        messages.push(`Inclus dans ${main.path}.`)
      }
    }
    if (changes.length === 0) return false
    view.dispatch({
      changes: composeInsertions(text.length, changes),
      userEvent: 'input.markdown',
    })
    return true
  }
  const previous = tools.activeDocument
  const done = await tools.editDocument(main.path, edit)
  if (!done && messages.length === 0) {
    messages.push(`${main.path} n’a pas pu être complété : ajoutez-y les packages nécessaires.`)
  }
  // Fragment inséré ailleurs que dans le document principal : retour au document courant.
  if (result.output === 'insert' && previous !== null && previous.id !== main.id) {
    tools.openDocument(previous.id)
  }
  return messages
}
