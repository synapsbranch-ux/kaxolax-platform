import { createHash } from 'node:crypto'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import {
  type ConvertRequest,
  type ConvertResult,
  markdownImportResponseSchema,
  type ProjectEvent,
  type ProjectSnapshot,
  verifyCompileWorkerToken,
} from '@kaxolax/contracts'
import { Secret } from '@adonisjs/core/helpers'
import app from '@adonisjs/core/services/app'
import testUtils from '@adonisjs/core/services/test_utils'
import db from '@adonisjs/lucid/services/db'
import { test } from '@japa/runner'
import type { ApiClient } from '@japa/api-client'
import compileConfig from '#config/compile'
import AiUsage from '#models/ai_usage'
import Document from '#models/document'
import File from '#models/file'
import Project from '#models/project'
import ProjectMember from '#models/project_member'
import type User from '#models/user'
import CompileGateway, {
  CompileServiceUnavailableException,
  ConvertFailedException,
} from '#services/compile_gateway'
import ObjectStorage from '#services/object_storage'
import RealtimeClient from '#services/realtime_client'
import { FakeAnthropicApi, useFakeClaude } from '#tests/claude'
import { createUser } from '#tests/helpers'

const sha256 = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
const SECRET = 'test-compile-worker-secret-0123456789abcdef'

/** PNG 4×4 (rouge), tel que pandoc l'extrait d'une image `data:`. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAIAAAAmkwkpAAAAEElEQVR4nGM4IScHRwzEcQCxYxBBO0tjggAAAABJRU5ErkJggg==',
  'base64',
)

const FRAGMENT = [
  '\\section{Introduction}\\label{introduction}',
  '',
  'Un \\href{https://pandoc.org}{lien}, $x^2$ et une image :',
  '',
  '\\begin{itemize}',
  '\\tightlist',
  '\\item',
  '  point',
  '\\end{itemize}',
  '',
  '\\pandocbounded{\\includegraphics[keepaspectratio]{chapters/media/plot.png}}',
  '',
].join('\n')

/** Réponse de l'agent pour `request` : fragment (ou document), une image `data:` extraite. */
function convertResult(request: ConvertRequest): ConvertResult {
  const mediaDir =
    request.mediaDir ?? `${request.targetPath.split('/').slice(0, -1).join('/')}/media`
  const path = `${mediaDir.replace(/^\//, '')}/plot.png`
  const document = request.options?.mode === 'document'
  return {
    latex: document
      ? `\\documentclass{article}\n\\usepackage{graphicx}\n\\begin{document}\n${FRAGMENT}\\end{document}\n`
      : FRAGMENT.replace('chapters/media/plot.png', path),
    preamble: document ? null : '\\usepackage{amsmath,amssymb}\n\\usepackage{graphicx}',
    title: 'Notes',
    media: [
      {
        path,
        contentType: 'image/png',
        sizeBytes: PNG.byteLength,
        sha256: sha256(PNG),
        contentBase64: PNG.toString('base64'),
      },
    ],
    images: [{ source: 'data:…', kind: 'embedded', path, reason: null, found: null }],
    citations: [],
    warnings: ['Image not found in the project: figures/absente.png'],
    durationMs: 120,
  }
}

/** Faux gateway : enregistre les conversions, répond comme l'agent (ou échoue). */
class FakeGateway extends CompileGateway {
  requests: ConvertRequest[] = []
  failure: Error | null = null
  gate: Promise<void> | null = null
  /** Attente propre à une demande (imports concurrents, terminés l'un après l'autre). */
  hold: ((request: ConvertRequest) => Promise<void>) | null = null
  /** LaTeX rendu à la place du fragment habituel. */
  latex: string | null = null
  /** Clés de citation rapportées par l'agent. */
  citations: string[] = []

  override async convert(request: ConvertRequest): Promise<ConvertResult> {
    this.requests.push(request)
    if (this.gate) await this.gate
    if (this.hold) await this.hold(request)
    if (this.failure) throw this.failure
    const result = convertResult(request)
    return Promise.resolve({
      ...result,
      citations: this.citations,
      ...(this.latex === null ? {} : { latex: this.latex }),
    })
  }
}

/** Faux temps réel : texte courant fixé par le test, événements enregistrés. */
class FakeRealtime extends RealtimeClient {
  live = new Map<string, string>()
  events: ProjectEvent[] = []

  override async snapshot(projectId: string): Promise<ProjectSnapshot | null> {
    if (this.live.size === 0) return Promise.resolve(null)
    return Promise.resolve({
      projectId,
      documents: [...this.live].map(([id, content]) => ({ id, content, sha256: sha256(content) })),
    })
  }

  override async publishProjectEvent(_projectId: string, event: ProjectEvent) {
    this.events.push(event)
    return Promise.resolve()
  }
}

/** Faux S3 : objets écrits et supprimés. */
class FakeStorage extends ObjectStorage {
  objects = new Map<string, Buffer>()
  deleted: string[] = []

  override async putBuffer(key: string, content: Buffer) {
    this.objects.set(key, content)
    return Promise.resolve()
  }

  override async delete(keys: readonly string[]) {
    for (const key of keys) {
      this.objects.delete(key)
      this.deleted.push(key)
    }
    return Promise.resolve()
  }
}

let gateway: FakeGateway
let realtime: FakeRealtime
let storage: FakeStorage

function useFakes(group: Parameters<Parameters<typeof test.group>[1]>[0]) {
  group.each.setup(() => testUtils.db().wrapInGlobalTransaction())
  group.each.setup(() => {
    gateway = new FakeGateway()
    realtime = new FakeRealtime()
    storage = new FakeStorage()
    app.container.swap(CompileGateway, () => gateway)
    app.container.swap(RealtimeClient, () => realtime)
    app.container.swap(ObjectStorage, () => storage)
    return () => {
      app.container.restore(CompileGateway)
      app.container.restore(RealtimeClient)
      app.container.restore(ObjectStorage)
    }
  })
}

async function newProject(client: ApiClient, user: User) {
  const created = await client.post('/api/v1/projects').json({ name: 'Notes' }).loginAs(user)
  const project = await Project.findOrFail(created.body().project.id)
  return { projectId: project.id, mainId: project.mainDocumentId ?? '' }
}

function convert(client: ApiClient, user: User, projectId: string, body: Record<string, unknown>) {
  return client.post(`/api/v1/projects/${projectId}/convert/markdown`).json(body).loginAs(user)
}

async function treePaths(projectId: string) {
  const documents = await Document.query().where('projectId', projectId)
  const files = await File.query().where('projectId', projectId)
  return { documents: documents.map((document) => document.name), files }
}

test.group('markdown import: files and preamble', (group) => {
  useFakes(group)

  test('creates the .tex file, its folders and the extracted images', async ({
    client,
    assert,
  }) => {
    const user = await createUser()
    const { projectId } = await newProject(client, user)
    const response = await convert(client, user, projectId, {
      markdown: '# Introduction\n\n![](data:image/png;base64,AAAA)',
      targetPath: 'chapters/intro.tex',
    })
    response.assertStatus(201)
    const body = markdownImportResponseSchema.parse(response.body())

    // Demande au sandbox : fragment, images relatives au document principal (racine).
    const [request] = gateway.requests
    assert.include(request, {
      projectId,
      sourcePath: 'pasted.md',
      targetPath: 'chapters/intro.tex',
      graphicsDir: '',
    })
    assert.deepEqual(request?.options, {
      mode: 'fragment',
      documentClass: 'article',
      topLevelDivision: 'section',
      citations: 'natbib',
    })

    assert.equal(body.document?.path, 'chapters/intro.tex')
    assert.equal(body.latex, FRAGMENT)
    assert.deepEqual(
      body.media.map((media) => [media.path, media.created]),
      [['chapters/media/plot.png', true]],
    )
    assert.include(body.warnings, 'Image not found in the project: figures/absente.png')

    // Document créé avec son contenu, et son auteur dans l'historique.
    const document = await Document.findOrFail(body.document?.id)
    assert.equal(document.contentSha256, sha256(FRAGMENT))
    const update = await db
      .from('document_updates')
      .where('document_id', document.id)
      .select('user_id')
      .first()
    assert.equal(update?.user_id, user.id)

    // Image : objet S3 et ligne files, contenu vérifié.
    const file = await File.findOrFail(body.media[0]?.id)
    assert.include(file.toJSON(), {
      name: 'plot.png',
      mimeType: 'image/png',
      sizeBytes: PNG.byteLength,
      sha256: sha256(PNG),
    })
    assert.deepEqual(storage.objects.get(file.s3Key), PNG)

    // Un seul événement : dossiers, image et document créés.
    assert.lengthOf(realtime.events, 1)
    const [event] = realtime.events
    assert.equal(event?.type, 'tree.changed')
    if (event?.type === 'tree.changed') {
      assert.equal(event.actorId, user.id)
      assert.deepEqual(
        event.changes.map((change) =>
          change.action === 'created' ? [change.entity, change.name] : [],
        ),
        [
          ['folder', 'chapters'],
          ['folder', 'media'],
          ['file', 'plot.png'],
          ['document', 'intro.tex'],
        ],
      )
    }
  })

  test('lists the packages the main document lacks, without duplicates', async ({
    client,
    assert,
  }) => {
    const user = await createUser()
    const { projectId, mainId } = await newProject(client, user)
    realtime.live.set(
      mainId,
      [
        '\\documentclass{report}',
        '\\usepackage{mathtools}',
        '\\usepackage{graphicx} % déjà là',
        '\\providecommand{\\tightlist}{}',
        '\\begin{document}',
        '\\end{document}',
      ].join('\n'),
    )
    const response = await convert(client, user, projectId, {
      markdown: '# Introduction',
      dryRun: true,
    })
    response.assertStatus(200)
    const { preamble } = markdownImportResponseSchema.parse(response.body())
    // Classe du document principal transmise à pandoc.
    assert.equal(gateway.requests[0]?.options?.documentClass, 'report')
    assert.deepEqual(
      preamble.packages.map((entry) => entry.name),
      ['amsmath', 'amssymb', 'graphicx', 'hyperref'],
    )
    assert.deepEqual(
      preamble.missingPackages.map((entry) => entry.name),
      ['amssymb', 'hyperref'],
    )
    assert.deepEqual(
      preamble.missingDefinitions.map((entry) => entry.name),
      ['pandocbounded'],
    )
    assert.equal(preamble.mainDocumentId, mainId)
    assert.equal(preamble.mainDocumentPath, 'main.tex')

    // Une fois le préambule complété, plus rien ne manque.
    realtime.live.set(
      mainId,
      [
        '\\documentclass{report}',
        '\\usepackage{mathtools}',
        '\\usepackage{graphicx}',
        '\\usepackage{amssymb}',
        ...preamble.missingDefinitions.map((entry) => entry.code),
        '\\providecommand{\\tightlist}{}',
        '\\usepackage{hyperref}',
        '\\begin{document}',
        '\\end{document}',
      ].join('\n'),
    )
    const again = await convert(client, user, projectId, { markdown: '# A', dryRun: true })
    const second = markdownImportResponseSchema.parse(again.body()).preamble
    assert.deepEqual(second.missingPackages, [])
    assert.deepEqual(second.missingDefinitions, [])
  })

  test('previews without writing anything', async ({ client, assert }) => {
    const user = await createUser()
    const { projectId } = await newProject(client, user)
    const before = await treePaths(projectId)
    const response = await convert(client, user, projectId, {
      markdown: '# A',
      targetPath: 'notes.tex',
      dryRun: true,
    })
    response.assertStatus(200)
    const body = markdownImportResponseSchema.parse(response.body())
    assert.isTrue(body.dryRun)
    assert.isNull(body.document)
    assert.deepEqual(body.media, [
      {
        id: null,
        path: 'media/plot.png',
        contentType: 'image/png',
        sizeBytes: PNG.byteLength,
        created: true,
      },
    ])
    assert.deepEqual(await treePaths(projectId), before)
    assert.equal(storage.objects.size, 0)
    assert.lengthOf(realtime.events, 0)
  })

  test('converts a Markdown document of the project next to it', async ({ client, assert }) => {
    const user = await createUser()
    const { projectId } = await newProject(client, user)
    const folder = await client
      .post(`/api/v1/projects/${projectId}/folders`)
      .json({ name: 'notes' })
      .loginAs(user)
    const created = await client
      .post(`/api/v1/projects/${projectId}/documents`)
      .json({ name: 'README.md', folderId: folder.body().folder.id, content: '# Notes\n' })
      .loginAs(user)
    const documentId = created.body().document.id as string

    const response = await convert(client, user, projectId, { documentId })
    response.assertStatus(201)
    const body = markdownImportResponseSchema.parse(response.body())
    assert.equal(body.targetPath, 'notes/README.tex')
    assert.include(gateway.requests[0], {
      sourcePath: 'notes/README.md',
      // Corps JSON rogné par l'API (espaces de fin).
      markdown: '# Notes',
    })

    // Un document qui n'est pas du Markdown, ou introuvable.
    const tex = await client
      .post(`/api/v1/projects/${projectId}/documents`)
      .json({ name: 'other.tex', content: 'x' })
      .loginAs(user)
    const notMarkdown = await convert(client, user, projectId, {
      documentId: tex.body().document.id,
    })
    notMarkdown.assertStatus(422)
    assert.equal(notMarkdown.body().code, 'E_NOT_MARKDOWN')
    const missing = await convert(client, user, projectId, {
      documentId: '6f1c2d3e-4b5a-4c7d-8e9f-0a1b2c3d4e5f',
    })
    missing.assertStatus(404)
  })

  test('returns a fragment to insert, writing only the images', async ({ client, assert }) => {
    const user = await createUser()
    const { projectId } = await newProject(client, user)
    const response = await convert(client, user, projectId, {
      markdown: '# A',
      output: 'insert',
      targetPath: 'chapters/one.tex',
    })
    response.assertStatus(201)
    const body = markdownImportResponseSchema.parse(response.body())
    assert.isNull(body.document)
    assert.equal(body.output, 'insert')
    assert.deepEqual(
      body.media.map((media) => media.path),
      ['chapters/media/plot.png'],
    )
    const { documents } = await treePaths(projectId)
    assert.deepEqual(documents, ['main.tex'])

    // L'image déjà présente avec ce contenu n'est pas recréée.
    const again = await convert(client, user, projectId, {
      markdown: '# A',
      output: 'insert',
      targetPath: 'chapters/one.tex',
    })
    again.assertStatus(200)
    assert.isFalse(markdownImportResponseSchema.parse(again.body()).media[0]?.created)
    assert.lengthOf((await treePaths(projectId)).files, 1)
  })

  test('writes a complete document with its own preamble', async ({ client, assert }) => {
    const user = await createUser()
    const { projectId } = await newProject(client, user)
    const response = await convert(client, user, projectId, {
      markdown: '# A',
      preamble: 'embedded',
      targetPath: 'standalone/notes.tex',
    })
    response.assertStatus(201)
    const body = markdownImportResponseSchema.parse(response.body())
    assert.include(gateway.requests[0], { graphicsDir: 'standalone' })
    assert.deepEqual(gateway.requests[0]?.options, {
      mode: 'document',
      documentClass: 'article',
      topLevelDivision: 'default',
      citations: 'natbib',
    })
    assert.include(body.latex, '\\documentclass{article}')
    assert.deepEqual(body.preamble.missingPackages, [])
  })

  test('writes the LaTeX validated in the preview', async ({ client, assert }) => {
    const user = await createUser()
    const { projectId } = await newProject(client, user)
    const validated = FRAGMENT.replace('\\tightlist\n', '').replace(
      'chapters/media/plot.png',
      'media/plot.png',
    )
    const response = await convert(client, user, projectId, {
      markdown: '# A',
      targetPath: 'clean.tex',
      latex: validated,
    })
    response.assertStatus(201)
    const body = markdownImportResponseSchema.parse(response.body())
    assert.equal(body.latex, validated.trimEnd())
    assert.notInclude(
      body.preamble.definitions.map((entry) => entry.name),
      'tightlist',
    )

    // Image perdue ou préambule dans un fragment : refusé.
    for (const latex of [
      'Sans image.',
      `\\documentclass{article}\n\\begin{document}\n${validated}\\end{document}`,
    ]) {
      const refused = await convert(client, user, projectId, {
        markdown: '# A',
        targetPath: 'other.tex',
        latex,
      })
      refused.assertStatus(422)
      assert.equal(refused.body().code, 'E_INVALID_LATEX')
    }
  })
  test('refuses the LaTeX validated in the preview of an older Markdown', async ({
    client,
    assert,
  }) => {
    const user = await createUser()
    const { projectId } = await newProject(client, user)
    const created = await client
      .post(`/api/v1/projects/${projectId}/documents`)
      .json({ name: 'notes.md', content: '# Notes' })
      .loginAs(user)
    const documentId = created.body().document.id as string
    const preview = markdownImportResponseSchema.parse(
      (await convert(client, user, projectId, { documentId, dryRun: true })).body(),
    )
    assert.equal(preview.sourceSha256, sha256('# Notes'))
    const validated = preview.latex.replace('\\tightlist\n', '')

    // Sans l'empreinte de l'aperçu : refusé avant toute conversion.
    const unsigned = await convert(client, user, projectId, { documentId, latex: validated })
    unsigned.assertStatus(422)

    // Le Markdown a changé depuis l'aperçu (collaborateur) : le texte validé est périmé.
    realtime.live.set(documentId, '# Notes\n\nUn paragraphe ajouté.')
    const requests = gateway.requests.length
    const stale = await convert(client, user, projectId, {
      documentId,
      latex: validated,
      sourceSha256: preview.sourceSha256,
    })
    stale.assertStatus(409)
    assert.equal(stale.body().code, 'E_SOURCE_CHANGED')
    assert.lengthOf(gateway.requests, requests)
    assert.deepEqual((await treePaths(projectId)).documents.sort(), ['main.tex', 'notes.md'])

    // Inchangé : écrit.
    realtime.live.set(documentId, '# Notes')
    const written = await convert(client, user, projectId, {
      documentId,
      latex: validated,
      sourceSha256: preview.sourceSha256,
    })
    written.assertStatus(201)
    assert.equal(markdownImportResponseSchema.parse(written.body()).latex, validated.trimEnd())
  })

  test('cites with the package of the main document and checks the keys', async ({
    client,
    assert,
  }) => {
    const user = await createUser()
    const { projectId, mainId } = await newProject(client, user)
    realtime.live.set(
      mainId,
      '\\documentclass{article}\n\\usepackage{biblatex}\n\\begin{document}\n\\end{document}\n',
    )
    gateway.citations = ['knuth84', 'absent']
    const withoutBib = markdownImportResponseSchema.parse(
      (await convert(client, user, projectId, { markdown: '[@knuth84]', dryRun: true })).body(),
    )
    assert.equal(gateway.requests[0]?.options?.citations, 'biblatex')
    assert.deepEqual(withoutBib.citations, ['knuth84', 'absent'])
    assert.include(
      withoutBib.warnings,
      'Citations need a .bib file in the project: knuth84, absent',
    )

    await client
      .post(`/api/v1/projects/${projectId}/documents`)
      .json({ name: 'refs.bib', content: '@book{knuth84,\n  title = {The TeXbook}\n}\n' })
      .loginAs(user)
    const withBib = markdownImportResponseSchema.parse(
      (
        await convert(client, user, projectId, {
          markdown: '[@knuth84]',
          citations: 'natbib',
          dryRun: true,
        })
      ).body(),
    )
    assert.equal(gateway.requests[1]?.options?.citations, 'natbib')
    assert.include(
      withBib.warnings,
      'Citation keys not found in the .bib files of the project: absent',
    )
  })

  test('ignores the LaTeX written in code blocks', async ({ client, assert }) => {
    const user = await createUser()
    const { projectId } = await newProject(client, user)
    // Bloc de code sans langue : pandoc recopie le texte dans un verbatim.
    const code = [
      'Un exemple :',
      '',
      '\\begin{verbatim}',
      '\\documentclass{article}',
      '\\begin{document}',
      '\\begin{itemize} % 100%',
      '\\end{verbatim}',
      '',
      'Et \\verb|\\begin{x}| en ligne.',
      '',
    ].join('\n')
    gateway.latex = code
    const response = await convert(client, user, projectId, {
      markdown: '```\n\\documentclass{article}\n\\begin{document}\n\\begin{itemize} % 100%\n```',
      targetPath: 'code.tex',
    })
    response.assertStatus(201)
    assert.equal(markdownImportResponseSchema.parse(response.body()).latex, code)

    // Hors verbatim, la structure compte toujours : un verbatim commenté n'ouvre rien.
    for (const latex of [
      '\\begin{itemize}\n\\item a\n',
      '% \\begin{verbatim}\n\\documentclass{article}\n\\end{verbatim}\n',
      '\\begin{verbatim}\nx % \\end{verbatim}\n\\end{verbatim}\n\\begin{document}\n',
    ]) {
      gateway.latex = latex
      const refused = await convert(client, user, projectId, {
        markdown: '# A',
        targetPath: 'refused.tex',
      })
      refused.assertStatus(422)
      assert.equal(refused.body().code, 'E_INVALID_LATEX')
    }
  })

  test('reuses an image created by a concurrent import, recreates a deleted one', async ({
    client,
    assert,
  }) => {
    const user = await createUser()
    const { projectId } = await newProject(client, user)
    const opened = new Map<string, () => void>()
    const gates = new Map<string, Promise<void>>()
    for (const markdown of ['# A', '# B', '# C']) {
      gates.set(
        markdown,
        new Promise((resolve) => {
          opened.set(markdown, resolve)
        }),
      )
    }
    const open = (markdown: string) => {
      opened.get(markdown)?.()
    }
    gateway.hold = (request) => gates.get(request.markdown) ?? Promise.resolve()
    // Deux imports de la même image : aucun ne la voit dans son instantané.
    const first = Promise.resolve(
      convert(client, user, projectId, { markdown: '# A', output: 'insert' }),
    )
    const second = Promise.resolve(
      convert(client, user, projectId, { markdown: '# B', output: 'insert' }),
    )
    while (gateway.requests.length < 2) await new Promise((resolve) => setTimeout(resolve, 10))
    open('# A')
    const created = await first
    created.assertStatus(201)
    open('# B')
    const reused = await second
    reused.assertStatus(200)
    const media = [created, reused].map(
      (answer) => markdownImportResponseSchema.parse(answer.body()).media,
    )
    assert.deepEqual(
      media.map((list) => list[0]?.created),
      [true, false],
    )
    const files = (await treePaths(projectId)).files
    assert.lengthOf(files, 1)
    assert.deepEqual(
      media.map((list) => list[0]?.id),
      [files[0]?.id, files[0]?.id],
    )
    // L'objet téléversé en double est supprimé, celui du fichier reste.
    assert.deepEqual([...storage.objects.keys()], [files[0]?.s3Key])

    // Image présente dans l'instantané mais supprimée pendant la conversion : recréée.
    const third = Promise.resolve(
      convert(client, user, projectId, { markdown: '# C', output: 'insert' }),
    )
    while (gateway.requests.length < 3) await new Promise((resolve) => setTimeout(resolve, 10))
    await File.query().where('projectId', projectId).delete()
    open('# C')
    const recreated = await third
    recreated.assertStatus(201)
    const [image] = markdownImportResponseSchema.parse(recreated.body()).media
    assert.isTrue(image?.created)
    const file = await File.findOrFail(image?.id)
    assert.deepEqual(storage.objects.get(file.s3Key), PNG)
  })
})

test.group('markdown import: permissions and limits', (group) => {
  useFakes(group)

  test('editors and owners convert, reviewers, viewers and strangers do not', async ({
    client,
    assert,
  }) => {
    const owner = await createUser()
    const { projectId } = await newProject(client, owner)
    for (const role of ['editor', 'reviewer', 'viewer'] as const) {
      const member = await createUser()
      await ProjectMember.create({ projectId, userId: member.id, role })
      const response = await convert(client, member, projectId, {
        markdown: '# A',
        targetPath: `${role}.tex`,
      })
      response.assertStatus(role === 'editor' ? 201 : 403)
    }
    ;(
      await convert(client, owner, projectId, { markdown: '# A', targetPath: 'owner.tex' })
    ).assertStatus(201)
    const stranger = await createUser()
    ;(await convert(client, stranger, projectId, { markdown: '# A' })).assertStatus(404)
    // Refusés avant le sandbox.
    assert.lengthOf(gateway.requests, 2)
  })

  test('refuses an existing target before converting', async ({ client, assert }) => {
    const user = await createUser()
    const { projectId } = await newProject(client, user)
    for (const targetPath of ['main.tex', 'main.tex/x.tex']) {
      const response = await convert(client, user, projectId, { markdown: '# A', targetPath })
      response.assertStatus(409)
      assert.equal(response.body().code, 'E_NAME_TAKEN')
    }
    assert.lengthOf(gateway.requests, 0)
  })

  test('validates the body', async ({ client }) => {
    const user = await createUser()
    const { projectId } = await newProject(client, user)
    for (const body of [
      {},
      { markdown: '# A', targetPath: '../evil.tex' },
      { markdown: '# A', targetPath: 'notes.md' },
      { markdown: '# A', output: 'insert', preamble: 'embedded' },
      { markdown: 'x'.repeat(2 * 1024 * 1024 + 1) },
    ]) {
      ;(await convert(client, user, projectId, body)).assertStatus(422)
    }
  })

  test('respects the storage of the owner plan and cleans the stored images', async ({
    client,
    assert,
  }) => {
    const user = await createUser()
    const { projectId } = await newProject(client, user)
    await File.create({
      projectId,
      folderId: null,
      name: 'big.pdf',
      s3Key: `projects/${projectId}/files/big`,
      sha256: 'a'.repeat(64),
      sizeBytes: 500 * 1024 * 1024,
      mimeType: 'application/pdf',
    })
    const response = await convert(client, user, projectId, {
      markdown: '# A',
      targetPath: 'notes.tex',
    })
    response.assertStatus(403)
    assert.equal(response.body().code, 'E_PLAN_LIMIT')
    assert.equal(response.body().limit.name, 'storage')
    // Rien d'écrit : objet S3 de l'image supprimé, aucun document.
    assert.equal(storage.objects.size, 0)
    assert.lengthOf(storage.deleted, 1)
    assert.deepEqual((await treePaths(projectId)).documents, ['main.tex'])
    assert.lengthOf(realtime.events, 0)
  })

  test('reports the sandbox errors', async ({ client, assert }) => {
    const user = await createUser()
    const { projectId } = await newProject(client, user)
    gateway.failure = new ConvertFailedException('The Markdown conversion took too long')
    const failed = await convert(client, user, projectId, { markdown: '# A' })
    failed.assertStatus(422)
    assert.equal(failed.body().code, 'E_CONVERT_FAILED')
    assert.equal(failed.body().message, 'The Markdown conversion took too long')

    gateway.failure = new CompileServiceUnavailableException()
    const unavailable = await convert(client, user, projectId, { markdown: '# A' })
    unavailable.assertStatus(503)
    assert.equal(unavailable.body().code, 'E_COMPILE_UNAVAILABLE')
    assert.deepEqual((await treePaths(projectId)).documents, ['main.tex'])
  })

  test('runs at most two conversions per user at once', async ({ client, assert }) => {
    const user = await createUser()
    const { projectId } = await newProject(client, user)
    let open: () => void = () => undefined
    gateway.gate = new Promise((resolve) => {
      open = resolve
    })
    // Requêtes envoyées tout de suite (le client de Japa n'envoie qu'à la première attente).
    const first = Promise.resolve(
      convert(client, user, projectId, { markdown: '# A', dryRun: true }),
    )
    const second = Promise.resolve(
      convert(client, user, projectId, { markdown: '# B', dryRun: true }),
    )
    while (gateway.requests.length < 2) await new Promise((resolve) => setTimeout(resolve, 10))
    const third = await convert(client, user, projectId, { markdown: '# C', dryRun: true })
    third.assertStatus(429)
    assert.equal(third.body().code, 'E_CONVERT_BUSY')
    open()
    ;(await first).assertStatus(200)
    ;(await second).assertStatus(200)
  })
})

test.group('markdown import: gateway answers', (group) => {
  const saved = { ...compileConfig }
  let server: Server
  let answer: { status: number; body: unknown } = { status: 200, body: {} }
  group.each.setup(() => testUtils.db().wrapInGlobalTransaction())
  group.each.setup(async () => {
    server = createServer((request, response) => {
      request.resume()
      request.on('end', () => {
        response.writeHead(answer.status, { 'content-type': 'application/json' })
        response.end(JSON.stringify(answer.body))
      })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    compileConfig.gatewayUrl = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`
    realtime = new FakeRealtime()
    app.container.swap(RealtimeClient, () => realtime)
    return async () => {
      Object.assign(compileConfig, saved)
      app.container.restore(RealtimeClient)
      await new Promise((resolve) => server.close(resolve))
    }
  })

  test('maps the failures of the agent', async ({ client, assert }) => {
    const user = await createUser()
    const { projectId } = await newProject(client, user)
    const cases = [
      [{ error: 'convert_failed', reason: 'timeout', message: '' }, 'took too long'],
      [{ error: 'convert_failed', reason: 'out_of_memory', message: '' }, 'ran out of memory'],
      [{ error: 'convert_failed', reason: 'failed', message: 'YAML error' }, ': YAML error'],
    ] as const
    for (const [body, message] of cases) {
      answer = { status: 422, body }
      const response = await convert(client, user, projectId, { markdown: '# A', dryRun: true })
      response.assertStatus(422)
      assert.equal(response.body().code, 'E_CONVERT_FAILED')
      assert.include(response.body().message, message)
    }
    // Demande refusée par l'agent (400) : erreur explicite, jamais une erreur interne.
    answer = { status: 400, body: { error: 'invalid_request' } }
    const rejected = await convert(client, user, projectId, { markdown: '# A', dryRun: true })
    rejected.assertStatus(422)
    assert.equal(rejected.body().code, 'E_CONVERT_REJECTED')
    answer = { status: 503, body: { error: 'convert_busy' } }
    ;(await convert(client, user, projectId, { markdown: '# A', dryRun: true })).assertStatus(503)
    // Réponse non conforme : jamais relayée.
    answer = { status: 200, body: { latex: 1 } }
    ;(await convert(client, user, projectId, { markdown: '# A', dryRun: true })).assertStatus(500)
  })
})

/** Faux Worker Cloudflare : vérifie le jeton du projet, répond comme le conteneur. */
class FakeWorker {
  server: Server | null = null
  requests: ConvertRequest[] = []

  async start(): Promise<string> {
    this.server = createServer((request, response) => {
      void this.handle(request).then(({ status, body }) => {
        response.writeHead(status, { 'content-type': 'application/json' })
        response.end(JSON.stringify(body))
      })
    })
    await new Promise<void>((resolve) => this.server?.listen(0, '127.0.0.1', resolve))
    return `http://127.0.0.1:${String((this.server.address() as AddressInfo).port)}`
  }

  async stop(): Promise<void> {
    await new Promise((resolve) => this.server?.close(resolve))
  }

  private async handle(request: IncomingMessage): Promise<{ status: number; body: unknown }> {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(chunk as Buffer)
    const projectId = /\/projects\/([^/]+)\/convert$/.exec(request.url ?? '')?.[1] ?? ''
    const token = (request.headers.authorization ?? '').replace(/^Bearer /, '')
    const claims = await verifyCompileWorkerToken(token, SECRET)
    if (claims?.projectId !== projectId) {
      return { status: 401, body: { error: 'unauthorized' } }
    }
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as ConvertRequest
    this.requests.push(body)
    return { status: 200, body: convertResult(body) }
  }
}

test.group('markdown import (cloudflare)', (group) => {
  const saved = { ...compileConfig }
  let worker: FakeWorker
  useFakes(group)
  group.each.setup(async () => {
    worker = new FakeWorker()
    compileConfig.backend = 'cloudflare'
    compileConfig.workerUrl = await worker.start()
    compileConfig.workerSecret = new Secret(SECRET)
    return async () => {
      Object.assign(compileConfig, saved)
      await worker.stop()
    }
  })

  test('goes through the container of the project', async ({ client, assert }) => {
    const user = await createUser()
    const { projectId } = await newProject(client, user)
    const response = await convert(client, user, projectId, {
      markdown: '# A',
      targetPath: 'notes.tex',
    })
    response.assertStatus(201)
    assert.lengthOf(worker.requests, 1)
    assert.lengthOf(gateway.requests, 0)
    assert.include(worker.requests[0], { projectId, targetPath: 'notes.tex' })
  })
})

test.group('markdown import: AI cleanup', (group) => {
  let api: FakeAnthropicApi
  useFakes(group)
  group.each.setup(() => {
    api = new FakeAnthropicApi()
    return useFakeClaude(api)
  })

  const usage = { input_tokens: 2000, output_tokens: 800 }

  test('cleans the LaTeX with Claude (effort low) and keeps the pandoc output', async ({
    client,
    assert,
  }) => {
    const user = await createUser()
    const { projectId } = await newProject(client, user)
    const cleaned = FRAGMENT.replace('\\tightlist\n', '').replace(
      'chapters/media/plot.png',
      'media/plot.png',
    )
    api.reply({
      content: [{ type: 'text', text: `\`\`\`latex\n${cleaned.trim()}\n\`\`\`` }],
      stop_reason: 'end_turn',
      usage,
    })
    const response = await convert(client, user, projectId, {
      markdown: '# A',
      targetPath: 'notes.tex',
      cleanup: true,
      dryRun: true,
    })
    response.assertStatus(200)
    const body = markdownImportResponseSchema.parse(response.body())
    assert.isTrue(body.cleanup?.applied)
    assert.isAbove(body.cleanup?.credits ?? 0, 0)
    assert.equal(body.latex, cleaned)
    assert.include(body.pandocLatex ?? '', '\\tightlist')

    const [sent] = api.messageRequests
    assert.deepEqual(sent?.body?.output_config, { effort: 'low' })
    assert.include(JSON.stringify(sent?.body?.messages), 'Mode: fragment')
    const recorded = await AiUsage.query().where('userId', user.id)
    assert.deepEqual(
      recorded.map((row) => [row.operation, row.projectId]),
      [['markdown_cleanup', projectId]],
    )
  })

  test('discards an answer that breaks the structure', async ({ client, assert }) => {
    const user = await createUser()
    const { projectId } = await newProject(client, user)
    api.reply({
      content: [
        {
          type: 'text',
          text: '\\documentclass{article}\n\\begin{document}\nTout réécrit.\n\\end{document}',
        },
      ],
      stop_reason: 'end_turn',
      usage,
    })
    const response = await convert(client, user, projectId, {
      markdown: '# A',
      cleanup: true,
      dryRun: true,
    })
    response.assertStatus(200)
    const body = markdownImportResponseSchema.parse(response.body())
    assert.isFalse(body.cleanup?.applied)
    assert.equal(body.latex, FRAGMENT.replace('chapters/media', 'media'))
    assert.isNull(body.pandocLatex)
    assert.isTrue(body.warnings.some((warning) => warning.includes('a fragment has no preamble')))
  })

  test('respects the AI switch of the project before converting', async ({ client, assert }) => {
    const user = await createUser()
    const { projectId } = await newProject(client, user)
    await Project.query().where('id', projectId).update({ aiEnabled: false })
    const response = await convert(client, user, projectId, { markdown: '# A', cleanup: true })
    response.assertStatus(403)
    assert.equal(response.body().code, 'E_AI_DISABLED')
    assert.lengthOf(gateway.requests, 0)
    // Sans nettoyage, la conversion reste possible.
    ;(await convert(client, user, projectId, { markdown: '# A', dryRun: true })).assertStatus(200)
  })

  test('refuses a cleanup when the AI is not configured or the text is too long', async ({
    client,
    assert,
  }) => {
    const user = await createUser()
    const { projectId } = await newProject(client, user)
    const tooLong = await convert(client, user, projectId, {
      markdown: 'x'.repeat(100_001),
      cleanup: true,
    })
    tooLong.assertStatus(422)
    assert.equal(tooLong.body().code, 'E_MARKDOWN_TOO_LARGE')

    useFakeClaude(null)
    const unavailable = await convert(client, user, projectId, { markdown: '# A', cleanup: true })
    unavailable.assertStatus(503)
    assert.equal(unavailable.body().code, 'E_AI_UNAVAILABLE')
    assert.lengthOf(gateway.requests, 0)
  })
})
