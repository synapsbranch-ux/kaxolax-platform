import { randomUUID } from 'node:crypto'
import {
  type CompileRequest,
  compileResultSchema,
  type CompileStatus,
  type GatewayCompileResponse,
  mePlanResponseSchema,
  planLimitErrorSchema,
} from '@kaxolax/contracts'
import app from '@adonisjs/core/services/app'
import testUtils from '@adonisjs/core/services/test_utils'
import db from '@adonisjs/lucid/services/db'
import mail from '@adonisjs/mail/services/main'
import { test } from '@japa/runner'
import type { ApiClient } from '@japa/api-client'
import { DateTime } from 'luxon'
import ClerkWebhookEvent from '#models/clerk_webhook_event'
import File from '#models/file'
import Project from '#models/project'
import ProjectMember from '#models/project_member'
import Subscription from '#models/subscription'
import type User from '#models/user'
import { PaymentPastDueMail, ProWelcomeMail } from '#mails/billing_mails'
import ProjectInvitationMail from '#mails/project_invitation_mail'
import CompileGateway from '#services/compile_gateway'
import { historyRetention, limitsOf, userAccount } from '#services/entitlements'
import RealtimeClient from '#services/realtime_client'
import { clerkTokenFor } from '#tests/clerk'
import { signWebhook } from '#tests/clerk_keys'
import { createUser, newClerkUserId } from '#tests/helpers'

const MIB = 1024 * 1024
const FREE_STORAGE = 500 * MIB
const ALL_FEATURES = 'u:long_compile,u:unlimited_collaborators,u:full_history,u:extra_storage'

/** Jeton de session dont les claims Billing disent Pro (sans miroir en base). */
function proToken(user: User): string {
  return clerkTokenFor(user, { pla: 'u:pro', fea: ALL_FEATURES })
}

/** Faux gateway : enregistre les demandes, répond avec le statut voulu. */
class FakeGateway extends CompileGateway {
  requests: CompileRequest[] = []
  status: CompileStatus = 'success'

  override async compile(request: CompileRequest): Promise<GatewayCompileResponse> {
    this.requests.push(request)
    return Promise.resolve({
      buildId: request.buildId,
      status: this.status,
      durationMs: request.timeoutMs,
      agentId: 'agent-test',
      outputFiles: [],
      entries: [],
      timings: { syncMs: 0, runMs: 0, uploadMs: 0 },
    })
  }
}

/** Sans instantané temps réel : le contenu stocké en base est compilé. */
class FakeRealtime extends RealtimeClient {
  override async snapshot() {
    return Promise.resolve(null)
  }

  override async closeDocuments() {
    return Promise.resolve()
  }
}

let gateway: FakeGateway
let mailer: ReturnType<typeof mail.fake>

async function newProject(client: ApiClient, user: User): Promise<string> {
  const response = await client.post('/api/v1/projects').json({ name: 'Billing' }).loginAs(user)
  response.assertStatus(201)
  return response.body().project.id as string
}

async function subscribe(user: User, planSlug: string, status = 'active') {
  await Subscription.create({
    userId: user.id,
    clerkSubscriptionItemId: `csi_${randomUUID()}`,
    planSlug,
    status,
    periodEnd: DateTime.utc().plus({ days: 20 }),
  })
}

/** Fichier binaire fictif (aucun objet S3) qui occupe `sizeBytes` du stockage du propriétaire. */
async function fillStorage(projectId: string, sizeBytes: number) {
  await File.create({
    projectId,
    folderId: null,
    name: `big-${randomUUID()}.pdf`,
    s3Key: `projects/${projectId}/files/${randomUUID()}`,
    sha256: 'a'.repeat(64),
    sizeBytes,
    mimeType: 'application/pdf',
  })
}

function useBillingFakes(group: Parameters<Parameters<typeof test.group>[1]>[0]) {
  group.each.setup(() => testUtils.db().wrapInGlobalTransaction())
  group.each.setup(() => {
    gateway = new FakeGateway()
    mailer = mail.fake()
    app.container.swap(CompileGateway, () => gateway)
    app.container.swap(RealtimeClient, () => new FakeRealtime())
    return () => {
      mail.restore()
      app.container.restore(CompileGateway)
      app.container.restore(RealtimeClient)
    }
  })
}

test.group('billing: entitlements and GET /me/plan', (group) => {
  useBillingFakes(group)

  test('defaults to the free plan', async ({ client, assert }) => {
    const user = await createUser()
    const response = await client.get('/api/v1/me/plan').loginAs(user)
    response.assertStatus(200)
    const plan = mePlanResponseSchema.parse(response.body())
    assert.include(plan, { plan: 'free', source: 'default', subscription: null })
    assert.deepEqual(plan.features, [])
    assert.deepEqual(plan.limits, {
      maxCompileSeconds: 20,
      maxCollaborators: 1,
      historyRetentionDays: 1,
      storageBytes: FREE_STORAGE,
    })
    assert.equal(plan.upgradeUrl, 'http://localhost:3000/pricing')
    assert.deepEqual(await historyRetention(userAccount(user.id)), { plan: 'free', days: 1 })
  })

  test('reads the plan and features from the token claims first', async ({ client, assert }) => {
    const user = await createUser()
    const projectId = await newProject(client, user)
    await ProjectMember.create({ projectId, userId: (await createUser()).id, role: 'viewer' })

    const response = await client.get('/api/v1/me/plan').bearerToken(proToken(user))
    const plan = mePlanResponseSchema.parse(response.body())
    assert.include(plan, { plan: 'pro', source: 'claims' })
    assert.lengthOf(plan.features, 4)
    assert.deepEqual(plan.limits, {
      maxCompileSeconds: 240,
      maxCollaborators: null,
      historyRetentionDays: null,
      storageBytes: 20 * 1024 * MIB,
    })
    assert.equal(plan.usage.maxCollaboratorsInProject, 1)
    assert.isAbove(plan.usage.storageBytes, 0)

    // Plan Pro sans la feature long_compile : la durée de Free s'applique.
    const partial = await client
      .get('/api/v1/me/plan')
      .bearerToken(clerkTokenFor(user, { pla: 'u:pro', fea: 'u:full_history' }))
    const partialPlan = mePlanResponseSchema.parse(partial.body())
    assert.equal(partialPlan.limits.maxCompileSeconds, 20)
    assert.isNull(partialPlan.limits.historyRetentionDays)
  })

  test('falls back on the subscriptions mirror without claims', async ({ client, assert }) => {
    const user = await createUser()
    await subscribe(user, 'free')
    await subscribe(user, 'pro', 'past_due')
    const response = await client.get('/api/v1/me/plan').loginAs(user)
    const plan = mePlanResponseSchema.parse(response.body())
    assert.include(plan, { plan: 'pro', source: 'subscription' })
    assert.equal(plan.subscription?.status, 'past_due')
    assert.equal(plan.limits.maxCompileSeconds, 240)
    assert.deepEqual(await historyRetention(userAccount(user.id)), { plan: 'pro', days: null })

    // Résilié : le plan reste acquis jusqu'à la fin de la période, puis Free.
    const other = await createUser()
    await subscribe(other, 'pro', 'canceled')
    assert.equal((await historyRetention(userAccount(other.id))).plan, 'pro')
    await Subscription.query().where('userId', other.id).update({ periodEnd: '2020-01-01' })
    assert.equal((await historyRetention(userAccount(other.id))).plan, 'free')
  })

  test('applies the free limits to a plan unknown to plan_limits', async ({ client, assert }) => {
    const user = await createUser()
    const response = await client
      .get('/api/v1/me/plan')
      .bearerToken(clerkTokenFor(user, { pla: 'u:enterprise', fea: ALL_FEATURES }))
    const plan = mePlanResponseSchema.parse(response.body())
    assert.equal(plan.plan, 'enterprise')
    assert.equal(plan.limits.maxCompileSeconds, 20)
    assert.equal(plan.limits.storageBytes, FREE_STORAGE)
  })
})

test.group('billing: compile time limit', (group) => {
  useBillingFakes(group)

  test('sends the compile time of the owner plan in every request', async ({ client, assert }) => {
    const owner = await createUser()
    const projectId = await newProject(client, owner)

    ;(await client.post(`/api/v1/projects/${projectId}/compile`).loginAs(owner)).assertStatus(200)
    ;(
      await client.post(`/api/v1/projects/${projectId}/compile`).bearerToken(proToken(owner))
    ).assertStatus(200)
    assert.deepEqual(
      gateway.requests.map((request) => request.timeoutMs),
      [20_000, 240_000],
    )

    // Un collaborateur Free : le plan relevé dans le dernier jeton du propriétaire (Pro).
    const collaborator = await createUser()
    await ProjectMember.create({ projectId, userId: collaborator.id, role: 'editor' })
    await client.post(`/api/v1/projects/${projectId}/compile`).loginAs(collaborator)
    assert.equal(gateway.requests.at(-1)?.timeoutMs, 240_000)

    // Un collaborateur Pro sur le projet d'un compte Free : limite du propriétaire.
    ;(
      await client.get('/api/v1/me').bearerToken(clerkTokenFor(owner, { pla: 'u:free' }))
    ).assertStatus(200)
    await client.post(`/api/v1/projects/${projectId}/compile`).bearerToken(proToken(collaborator))
    assert.equal(gateway.requests.at(-1)?.timeoutMs, 20_000)

    // Propriétaire Pro (miroir des webhooks), compilation lancée par un collaborateur Free.
    await subscribe(owner, 'pro')
    await client.post(`/api/v1/projects/${projectId}/compile`).loginAs(collaborator)
    assert.equal(gateway.requests.at(-1)?.timeoutMs, 240_000)
  })

  test('points a free timeout to the pricing page, not a pro one', async ({ client, assert }) => {
    const owner = await createUser()
    const projectId = await newProject(client, owner)
    gateway.status = 'timeout'

    const free = await client.post(`/api/v1/projects/${projectId}/compile`).loginAs(owner)
    const result = compileResultSchema.parse(free.body())
    assert.equal(result.status, 'timeout')
    assert.deepEqual(result.planLimit?.limit, { name: 'compile_time', plan: 'free', max: 20 })
    assert.equal(result.planLimit?.feature, 'long_compile')

    // Dernière compilation relue : même indication.
    const last = await client.get(`/api/v1/projects/${projectId}/compile/last`).loginAs(owner)
    assert.equal(compileResultSchema.parse(last.body().compile).planLimit?.limit.max, 20)

    const pro = await client
      .post(`/api/v1/projects/${projectId}/compile`)
      .bearerToken(proToken(owner))
    assert.isUndefined(compileResultSchema.parse(pro.body()).planLimit)

    // Build Pro (240 s) relu après le retour au plan Free : ce n'est pas la limite du plan Free.
    ;(
      await client.get('/api/v1/me').bearerToken(clerkTokenFor(owner, { pla: 'u:free' }))
    ).assertStatus(200)
    const downgraded = await client.get(`/api/v1/projects/${projectId}/compile/last`).loginAs(owner)
    const reread = compileResultSchema.parse(downgraded.body().compile)
    assert.equal(reread.status, 'timeout')
    assert.isUndefined(reread.planLimit)
  })
})

test.group('billing: storage limit', (group) => {
  useBillingFakes(group)

  test('refuses documents, uploads and projects beyond the storage of the owner plan', async ({
    client,
    assert,
  }) => {
    const owner = await createUser()
    const projectId = await newProject(client, owner)
    await fillStorage(projectId, FREE_STORAGE)

    const document = await client
      .post(`/api/v1/projects/${projectId}/documents`)
      .json({ name: 'chapter.tex', content: 'x' })
      .loginAs(owner)
    document.assertStatus(403)
    const body = planLimitErrorSchema.parse(document.body())
    assert.deepEqual(body.limit, { name: 'storage', plan: 'free', max: FREE_STORAGE })
    assert.equal(body.feature, 'extra_storage')
    assert.isAtLeast(body.current ?? 0, FREE_STORAGE)
    assert.equal(body.upgradeUrl, 'http://localhost:3000/pricing')

    // Un éditeur ajoute au stockage du propriétaire, quel que soit son propre plan.
    const editor = await createUser()
    await ProjectMember.create({ projectId, userId: editor.id, role: 'editor' })
    const refused = await client
      .post(`/api/v1/projects/${projectId}/uploads`)
      .json({ filename: 'figure.png', folderId: null, sizeBytes: 10 })
      .bearerToken(proToken(editor))
    refused.assertStatus(403)
    // L'usage de tout le compte du propriétaire n'est pas montré à un collaborateur.
    assert.notProperty(planLimitErrorSchema.parse(refused.body()), 'current')
    ;(await client.post('/api/v1/projects').json({ name: 'Another' }).loginAs(owner)).assertStatus(
      403,
    )
    ;(
      await client.post('/api/v1/imports').json({ filename: 'a.zip', sizeBytes: 10 }).loginAs(owner)
    ).assertStatus(403)

    // Le stockage de Pro (claims du propriétaire) laisse passer.
    ;(
      await client
        .post(`/api/v1/projects/${projectId}/documents`)
        .json({ name: 'chapter.tex', content: 'x' })
        .bearerToken(proToken(owner))
    ).assertStatus(201)
  })

  test('checks the storage again when an upload completes', async ({ client, assert }) => {
    const owner = await createUser()
    const projectId = await newProject(client, owner)
    const content = Buffer.from('\\section{Annexe}\n')
    const started = await client
      .post(`/api/v1/projects/${projectId}/uploads`)
      .json({ filename: 'annexe.tex', folderId: null, sizeBytes: content.length })
      .loginAs(owner)
    started.assertStatus(201)
    const { uploadId, url } = started.body() as { uploadId: string; url: string }
    assert.isTrue((await fetch(url, { method: 'PUT', body: content })).ok)

    // Rempli entre le début et la fin de l'upload.
    await fillStorage(projectId, FREE_STORAGE - 10)
    const completed = await client
      .post(`/api/v1/projects/${projectId}/uploads/${uploadId}/complete`)
      .loginAs(owner)
    completed.assertStatus(403)
    assert.equal(planLimitErrorSchema.parse(completed.body()).limit.name, 'storage')
  })
})

test.group('billing: collaborator limit with claims', (group) => {
  useBillingFakes(group)

  test('lets a Pro owner (token claims) invite beyond the free limit', async ({
    client,
    assert,
  }) => {
    const owner = await createUser()
    const projectId = await newProject(client, owner)
    const invite = (token: string) =>
      client
        .post(`/api/v1/projects/${projectId}/invitations`)
        .json({ email: `guest-${randomUUID()}@example.com`, role: 'viewer' })
        .bearerToken(token)
    ;(await invite(clerkTokenFor(owner))).assertStatus(201)
    const refused = await invite(clerkTokenFor(owner))
    refused.assertStatus(403)
    const body = planLimitErrorSchema.parse(refused.body())
    assert.deepEqual(body.limit, { name: 'collaborators', plan: 'free', max: 1 })
    assert.equal(body.feature, 'unlimited_collaborators')
    assert.equal(body.current, 1)
    ;(await invite(proToken(owner))).assertStatus(201)
  })
})

/** Jeton (en clair) du dernier email d'invitation envoyé à cette adresse. */
function lastInvitationToken(email: string): string {
  const last = mailer.mails
    .sent(
      (candidate) =>
        candidate instanceof ProjectInvitationMail && candidate.data.to === email.toLowerCase(),
    )
    .at(-1)
  if (!(last instanceof ProjectInvitationMail)) throw new Error(`no invitation sent to ${email}`)
  const token = last.data.url.split('/invitations/')[1]
  if (!token) throw new Error('malformed invitation url')
  return token
}

test.group('billing: collaborator limit read from one source per project', (group) => {
  useBillingFakes(group)

  test('accepts an invitation sent under the Pro claims of the owner while the mirror lags', async ({
    client,
    assert,
  }) => {
    const owner = await createUser()
    const projectId = await newProject(client, owner)
    const guests = [await createUser(), await createUser()]
    for (const guest of guests) {
      const sent = await client
        .post(`/api/v1/projects/${projectId}/invitations`)
        .json({ email: guest.email, role: 'viewer' })
        .bearerToken(proToken(owner))
      sent.assertStatus(201)
    }
    // Aucun miroir (webhook en retard ou refusé) : le plan relevé dans le jeton du propriétaire
    // s'applique aussi quand l'invité agit.
    const [first, second] = guests as [User, User]
    const accepted = await client
      .post(`/api/v1/invitations/${lastInvitationToken(first.email)}/accept`)
      .loginAs(first)
    accepted.assertStatus(200)

    // Le miroir reçoit ensuite un état plus récent (retour à Free) : il prime sur le relevé.
    await subscribe(owner, 'free')
    const refused = await client
      .post(`/api/v1/invitations/${lastInvitationToken(second.email)}/accept`)
      .loginAs(second)
    refused.assertStatus(403)
    assert.deepEqual(planLimitErrorSchema.parse(refused.body()).limit, {
      name: 'collaborators',
      plan: 'free',
      max: 1,
    })
  })

  test('records the plan of the latest token only, never an older one', async ({
    client,
    assert,
  }) => {
    const owner = await createUser()
    const now = Math.floor(Date.now() / 1000)
    const me = (overrides: Record<string, unknown>) =>
      client.get('/api/v1/me').bearerToken(clerkTokenFor(owner, overrides))
    ;(await me({ pla: 'u:pro', fea: ALL_FEATURES, iat: now })).assertStatus(200)
    ;(await me({ pla: 'u:free', fea: '', iat: now - 30 })).assertStatus(200)
    await owner.refresh()
    const row = (await db
      .from('users')
      .where('id', owner.id)
      .select('claimed_plan_slug', 'claimed_plan_features')
      .firstOrFail()) as { claimed_plan_slug: string; claimed_plan_features: string[] }
    assert.equal(row.claimed_plan_slug, 'pro')
    assert.sameMembers(row.claimed_plan_features, [
      'extra_storage',
      'full_history',
      'long_compile',
      'unlimited_collaborators',
    ])
    assert.equal((await limitsOf(owner)).entitlements.source, 'claims')
  })
})

test.group('billing: ownership transfer', (group) => {
  useBillingFakes(group)

  test('refuses a project larger than the storage of the new owner plan', async ({
    client,
    assert,
  }) => {
    const owner = await createUser()
    const next = await createUser()
    const projectId = await newProject(client, owner)
    await ProjectMember.create({ projectId, userId: next.id, role: 'viewer' })
    await fillStorage(projectId, FREE_STORAGE + 1)
    const transfer = () =>
      client
        .post(`/api/v1/projects/${projectId}/transfer`)
        .json({ userId: next.id })
        .bearerToken(proToken(owner))

    const refused = await transfer()
    refused.assertStatus(403)
    const body = planLimitErrorSchema.parse(refused.body())
    assert.deepEqual(body.limit, { name: 'storage', plan: 'free', max: FREE_STORAGE })
    assert.equal((await Project.findOrFail(projectId)).ownerId, owner.id)
    const roles = await ProjectMember.query().where('project_id', projectId).orderBy('role')
    assert.sameDeepMembers(
      roles.map((member) => ({ userId: member.userId, role: member.role })),
      [
        { userId: owner.id, role: 'owner' },
        { userId: next.id, role: 'viewer' },
      ],
    )

    await subscribe(next, 'pro')
    ;(await transfer()).assertStatus(200)
    assert.equal((await Project.findOrFail(projectId)).ownerId, next.id)
  })

  test('counts the former owner as a collaborator of the new owner', async ({ client, assert }) => {
    const owner = await createUser()
    const next = await createUser()
    const other = await createUser()
    const projectId = await newProject(client, owner)
    await ProjectMember.create({ projectId, userId: next.id, role: 'editor' })
    await ProjectMember.create({ projectId, userId: other.id, role: 'viewer' })
    const transfer = () =>
      client
        .post(`/api/v1/projects/${projectId}/transfer`)
        .json({ userId: next.id })
        .bearerToken(proToken(owner))

    // Après le transfert : l'ancien propriétaire (éditeur) et l'autre membre, 2 > 1 (Free).
    const refused = await transfer()
    refused.assertStatus(403)
    const body = planLimitErrorSchema.parse(refused.body())
    assert.deepEqual(body.limit, { name: 'collaborators', plan: 'free', max: 1 })
    assert.equal(body.current, 2)
    assert.equal((await Project.findOrFail(projectId)).ownerId, owner.id)

    await ProjectMember.query().where({ projectId, userId: other.id }).delete()
    ;(await transfer()).assertStatus(200)
    assert.equal((await Project.findOrFail(projectId)).ownerId, next.id)
  })
})

// --- Webhooks Billing -------------------------------------------------------------------------

interface ItemOptions {
  plan?: 'free' | 'pro' | 'team'
  periodEnd?: number | null
  payer?: Record<string, unknown>
}

/** Élément d'abonnement tel que l'envoient les webhooks Billing de Clerk. */
function billingItem(user: User | null, id: string, status: string, options: ItemOptions = {}) {
  const plan = options.plan ?? 'pro'
  return {
    id,
    object: 'commerce_subscription_item',
    status,
    plan_period: 'month',
    period_start: Date.now(),
    period_end: options.periodEnd === undefined ? Date.now() + 30 * 86_400_000 : options.periodEnd,
    plan: {
      id: `cplan_${plan}`,
      name: plan === 'pro' ? 'Pro' : plan === 'team' ? 'Team' : 'Free',
      slug: plan,
      is_default: plan === 'free',
    },
    payer: options.payer ?? { user_id: user?.clerkUserId, email: user?.email },
  }
}

async function sendEvent(
  client: ApiClient,
  type: string,
  data: Record<string, unknown>,
  options: { id?: string; timestamp?: number } = {},
) {
  const body = JSON.stringify({
    type,
    object: 'event',
    data,
    timestamp: options.timestamp ?? Date.now(),
    instance_id: 'ins_test',
  })
  return client
    .post('/api/v1/webhooks/clerk')
    .headers({ ...signWebhook(body, undefined, options.id), 'content-type': 'application/json' })
    .json(JSON.parse(body) as object)
}

function sentMails() {
  return mailer.mails.sent()
}

test.group('billing: webhooks', (group) => {
  useBillingFakes(group)

  test('mirrors a subscription item and ignores a replayed delivery', async ({
    client,
    assert,
  }) => {
    const user = await createUser()
    const id = `msg_${randomUUID()}`
    const at = Date.now()
    const data = billingItem(user, 'csi_pro_1', 'active')
    ;(await sendEvent(client, 'subscriptionItem.active', data, { id, timestamp: at })).assertStatus(
      204,
    )

    const row = await Subscription.findByOrFail('clerkSubscriptionItemId', 'csi_pro_1')
    assert.include(row.$attributes, { userId: user.id, planSlug: 'pro', status: 'active' })
    assert.equal(row.updatedAt.toMillis(), at)
    assert.isNotNull(row.periodEnd)
    const [welcome] = sentMails()
    assert.lengthOf(sentMails(), 1)
    assert.instanceOf(welcome, ProWelcomeMail)
    if (welcome instanceof ProWelcomeMail) {
      assert.equal(welcome.data.to, user.email)
      assert.equal(welcome.data.billingUrl, 'http://localhost:3000/account/billing')
      assert.include(welcome.message.toJSON().message.text, 'plan Pro')
    }

    // Même livraison rejouée (même svix-id), même avec un autre contenu : aucun effet.
    const replay = billingItem(user, 'csi_pro_1', 'past_due')
    ;(
      await sendEvent(client, 'subscriptionItem.pastDue', replay, { id, timestamp: at + 1000 })
    ).assertStatus(204)
    await row.refresh()
    assert.equal(row.status, 'active')
    assert.lengthOf(sentMails(), 1)
    assert.lengthOf(await ClerkWebhookEvent.query().where('id', id), 1)

    // Droits sans claims : miroir.
    const plan = mePlanResponseSchema.parse(
      (await client.get('/api/v1/me/plan').loginAs(user)).body(),
    )
    assert.include(plan, { plan: 'pro', source: 'subscription' })
  })

  test('never lets an older event overwrite a newer state', async ({ client, assert }) => {
    const user = await createUser()
    const t1 = Date.now() - 60_000
    const t2 = Date.now()
    // Livrés dans le désordre : le retard de paiement (t2) arrive avant l'activation (t1).
    await sendEvent(client, 'subscriptionItem.pastDue', billingItem(user, 'csi_2', 'past_due'), {
      timestamp: t2,
    })
    await sendEvent(client, 'subscriptionItem.active', billingItem(user, 'csi_2', 'active'), {
      timestamp: t1,
    })
    const row = await Subscription.findByOrFail('clerkSubscriptionItemId', 'csi_2')
    assert.equal(row.status, 'past_due')
    assert.equal(row.updatedAt.toMillis(), t2)
    assert.deepEqual(
      sentMails().map((sent) => sent.constructor.name),
      [PaymentPastDueMail.name],
    )

    // Paiement régularisé plus tard : actif, sans second email de bienvenue.
    await sendEvent(client, 'subscriptionItem.active', billingItem(user, 'csi_2', 'active'), {
      timestamp: t2 + 1000,
    })
    await row.refresh()
    assert.equal(row.status, 'active')
    assert.lengthOf(sentMails(), 1)
  })

  test('sends one email per transition across subscription and item events', async ({
    client,
    assert,
  }) => {
    const user = await createUser()
    const at = Date.now()
    const free = billingItem(user, 'csi_free', 'ended', { plan: 'free' })
    const pro = billingItem(user, 'csi_pro', 'active')
    const subscription = {
      id: 'csub_1',
      object: 'commerce_subscription',
      status: 'active',
      payer: { user_id: user.clerkUserId },
      items: [free, { ...pro, payer: undefined }],
      updated_at: at,
    }
    await sendEvent(client, 'subscription.active', subscription, { timestamp: at })
    await sendEvent(client, 'subscriptionItem.active', pro, { timestamp: at })
    assert.lengthOf(sentMails(), 1)
    assert.equal(
      (await Subscription.findByOrFail('clerkSubscriptionItemId', 'csi_free')).status,
      'ended',
    )

    const pastDue = billingItem(user, 'csi_pro', 'past_due')
    await sendEvent(
      client,
      'subscription.pastDue',
      { ...subscription, status: 'past_due', items: [pastDue] },
      { timestamp: at + 1000 },
    )
    await sendEvent(client, 'subscriptionItem.pastDue', pastDue, { timestamp: at + 1000 })
    assert.deepEqual(
      sentMails().map((sent) => sent.constructor.name),
      [ProWelcomeMail.name, PaymentPastDueMail.name],
    )
  })

  test('keeps a billing email that could not be sent and sends it on the next delivery', async ({
    client,
    assert,
  }) => {
    const user = await createUser()
    const id = `msg_${randomUUID()}`
    const data = billingItem(user, 'csi_mail', 'past_due')
    // Panne SMTP passagère : la transition est enregistrée, l'email reste en attente.
    const send = mail.send.bind(mail)
    mail.send = () => Promise.reject(new Error('SMTP unavailable'))
    try {
      const failed = await sendEvent(client, 'subscriptionItem.pastDue', data, { id })
      failed.assertStatus(503)
      failed.assertBodyContains({ code: 'E_BILLING_MAIL_PENDING' })
    } finally {
      mail.send = send
    }
    assert.equal(
      (await Subscription.findByOrFail('clerkSubscriptionItemId', 'csi_mail')).status,
      'past_due',
    )
    assert.lengthOf(sentMails(), 0)
    const [pending] = await db.from('billing_mails').where('event_id', id)
    assert.include(pending, { attempts: 1, sent_at: null, kind: 'paymentPastDue' })

    // Relivraison par Clerk : l'événement n'est pas réappliqué, l'email part enfin.
    ;(await sendEvent(client, 'subscriptionItem.pastDue', data, { id })).assertStatus(204)
    assert.deepEqual(
      sentMails().map((sent) => sent.constructor.name),
      [PaymentPastDueMail.name],
    )
    const [sent] = await db.from('billing_mails').where('event_id', id)
    assert.isNotNull(sent.sent_at)

    // Livraison suivante : rien à renvoyer.
    ;(await sendEvent(client, 'subscriptionItem.pastDue', data, { id })).assertStatus(204)
    assert.lengthOf(sentMails(), 1)
  })

  test('asks Clerk to retry while the payer is unknown', async ({ client, assert }) => {
    const clerkUserId = newClerkUserId()
    const id = `msg_${randomUUID()}`
    const data = billingItem(null, 'csi_early', 'active', { payer: { user_id: clerkUserId } })
    const early = await sendEvent(client, 'subscriptionItem.active', data, { id })
    early.assertStatus(409)
    early.assertBodyContains({ code: 'E_BILLING_PAYER_UNKNOWN' })
    // Rien d'enregistré : la nouvelle livraison sera traitée.
    assert.isNull(await ClerkWebhookEvent.find(id))

    const user = await createUser()
    user.clerkUserId = clerkUserId
    await user.save()
    ;(await sendEvent(client, 'subscriptionItem.active', data, { id })).assertStatus(204)
    assert.equal(
      (await Subscription.findByOrFail('clerkSubscriptionItemId', 'csi_early')).userId,
      user.id,
    )
  })

  test('mirrors organization payers without email, ignores unrelated events', async ({
    client,
    assert,
  }) => {
    // Plan d'organisation (tâche 10) : reflété par `clerk_organization_id`, sans email.
    const data = billingItem(null, 'csi_org', 'active', { payer: { organization_id: 'org_1' } })
    ;(await sendEvent(client, 'subscriptionItem.active', data)).assertStatus(204)
    ;(
      await sendEvent(client, 'paymentAttempt.created', { id: 'pa_1', status: 'paid' })
    ).assertStatus(204)
    const mirrored = await Subscription.findByOrFail('clerkSubscriptionItemId', 'csi_org')
    assert.isNull(mirrored.userId)
    assert.equal(mirrored.clerkOrganizationId, 'org_1')
    assert.lengthOf(sentMails(), 0)
  })

  test('treats a payer carrying both user_id and organization_id as the organization', async ({
    client,
    assert,
  }) => {
    // `BillingPayerJSON` déclare les deux champs facultatifs et indépendants : le membre qui a
    // souscrit peut figurer à côté de l'organisation, l'abonnement reste celui de l'équipe.
    const member = await createUser()
    const data = billingItem(member, 'csi_org_both', 'active', {
      plan: 'team',
      payer: { user_id: member.clerkUserId, organization_id: 'org_both' },
    })
    ;(await sendEvent(client, 'subscriptionItem.active', data)).assertStatus(204)
    const mirrored = await Subscription.findByOrFail('clerkSubscriptionItemId', 'csi_org_both')
    assert.isNull(mirrored.userId)
    assert.equal(mirrored.clerkOrganizationId, 'org_both')
    assert.equal(mirrored.planSlug, 'team')
    assert.isNull(await Subscription.findBy('userId', member.id))
    assert.lengthOf(sentMails(), 0)
  })
})
